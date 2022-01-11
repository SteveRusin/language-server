import { Expression } from '@cucumber/cucumber-expressions'
import {
  buildStepDocuments,
  getGherkinCompletionItems,
  getGherkinDiagnostics,
  getGherkinFormattingEdits,
  getGherkinSemanticTokens,
  Index,
  jsSearchIndex,
  semanticTokenTypes,
  StepDocument,
} from '@cucumber/language-service'
import {
  ConfigurationRequest,
  Connection,
  DidChangeConfigurationNotification,
  ServerCapabilities,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { buildStepTexts } from './buildStepTexts'
import { loadAll } from './loadAll'
import { ExpressionBuilder, LanguageName } from './tree-sitter/ExpressionBuilder.js'
import { Settings } from './types'
import { version } from './version.js'

type ServerInfo = {
  name: string
  version: string
}

export class CucumberLanguageServer {
  private expressions: readonly Expression[] = []
  private index: Index
  private expressionBuilder = new ExpressionBuilder()

  constructor(
    private readonly connection: Connection,
    private readonly documents: TextDocuments<TextDocument>
  ) {
    connection.onInitialize(async (params) => {
      // await connection.console.info(
      //   'CucumberLanguageServer initializing: ' + JSON.stringify(params, null, 2)
      // )

      await this.expressionBuilder.init({
        // Relative to dist/src/cjs
        java: `${__dirname}/../../../tree-sitter-java.wasm`,
        typescript: `${__dirname}/../../../tree-sitter-typescript.wasm`,
      })

      if (params.capabilities.workspace?.configuration) {
        connection.onDidChangeConfiguration((params) => {
          this.connection.console.log(
            '*** onDidChangeConfiguration: ' + JSON.stringify(params, null, 2)
          )
          this.updateSettings(<Settings>params.settings).catch((err) => {
            this.connection.console.error(`Failed to update settings: ${err.message}`)
          })
        })
        try {
          await connection.client.register(DidChangeConfigurationNotification.type)
        } catch (err) {
          await connection.console.warn(
            'Could not register DidChangeConfigurationNotification: ' + err.message
          )
        }
      } else {
        console.log('*** Disabled onDidChangeConfiguration')
      }

      if (params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
        connection.onDidChangeWatchedFiles(async ({ changes }) => {
          if (!changes) {
            await connection.console.error('*** onDidChangeWatchedFiles - no changes??')
          } else {
            await connection.console.info(`*** onDidChangeWatchedFiles`)
          }
        })
        // await connection.client.register(DidChangeWatchedFilesNotification.type, {
        //   // TODO: Take from settings
        //   watchers: [{ globPattern: 'features/**/*.{feature,java,ts}' }],
        // })
      } else {
        console.log('*** Disabled onDidChangeWatchedFiles')
      }

      if (params.capabilities.textDocument?.semanticTokens) {
        connection.languages.semanticTokens.on((semanticTokenParams) => {
          const doc = documents.get(semanticTokenParams.textDocument.uri)
          if (!doc) return { data: [] }
          const gherkinSource = doc.getText()
          return getGherkinSemanticTokens(gherkinSource, this.expressions)
        })
      } else {
        console.log('*** Disabled semanticTokens')
      }

      if (params.capabilities.textDocument?.completion?.completionItem?.snippetSupport) {
        connection.onCompletion((params) => {
          if (!this.index) return []
          const doc = documents.get(params.textDocument.uri)
          if (!doc) return []
          const gherkinSource = doc.getText()
          return getGherkinCompletionItems(gherkinSource, params.position.line, this.index)
        })

        connection.onCompletionResolve((item) => item)
      } else {
        console.log('*** Disabled onCompletion')
      }

      if (params.capabilities.textDocument?.formatting) {
        connection.onDocumentFormatting((params) => {
          const doc = documents.get(params.textDocument.uri)
          if (!doc) return []
          const gherkinSource = doc.getText()
          return getGherkinFormattingEdits(gherkinSource)
        })
      } else {
        console.log('*** Disabled onDocumentFormatting')
      }

      await connection.console.info('Cucumber Language server initialized')

      return {
        capabilities: this.capabilities(),
        serverInfo: this.info(),
      }
    })

    connection.onInitialized(() => {
      console.log('*** onInitialized')
    })

    documents.listen(connection)

    // The content of a text document has changed. This event is emitted
    // when the text document is first opened or when its content has changed.
    documents.onDidChangeContent(async (change) => {
      if (change.document.uri.match(/\.feature$/)) {
        this.validateGherkinDocument(change.document)
      }
      const settings = await this.getSettings()
      if (settings) {
        await this.updateSettings(settings)
      } else {
        await this.connection.console.warn('Could not get cucumber.* settings')
      }
      console.log('onDidChangeContent', { settings })
    })
  }

  private async getSettings(): Promise<Settings | undefined> {
    try {
      const config = await this.connection.sendRequest(ConfigurationRequest.type, {
        items: [
          {
            section: 'cucumber',
          },
        ],
      })
      return config && config.length === 1 ? config[0] : undefined
    } catch (err) {
      await this.connection.console.error('Could not request configuration: ' + err.message)
    }
  }

  public capabilities(): ServerCapabilities {
    return {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
      },
      workspace: {
        workspaceFolders: {
          changeNotifications: true,
          supported: true,
        },
      },
      semanticTokensProvider: {
        full: {
          delta: false,
        },
        legend: {
          tokenTypes: semanticTokenTypes,
          tokenModifiers: [],
        },
      },
      documentFormattingProvider: true,
    }
  }

  public info(): ServerInfo {
    return {
      name: 'Cucumber Language Server',
      version,
    }
  }

  private validateGherkinDocument(textDocument: TextDocument): void {
    const diagnostics = getGherkinDiagnostics(textDocument.getText(), this.expressions)
    this.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
  }

  private async updateSettings(settings: Settings) {
    // TODO: Send WorkDoneProgressBegin notification
    // https://microsoft.github.io/language-server-protocol/specifications/specification-3-17/#workDoneProgress

    const stepDocuments = await this.buildStepDocuments(
      settings.features,
      settings.stepdefinitions,
      settings.language
    )
    await this.connection.console.info(
      `Built ${stepDocuments.length} step documents for auto complete`
    )
    this.index = jsSearchIndex(stepDocuments)

    // TODO: Send WorkDoneProgressEnd notification
  }

  private async buildStepDocuments(
    gherkinGlobs: readonly string[],
    glueGlobs: readonly string[],
    languageName: LanguageName
  ): Promise<readonly StepDocument[]> {
    const gherkinSources = await loadAll(gherkinGlobs)
    await this.connection.console.info(`Found ${gherkinSources.length} feature files`)
    const stepTexts = gherkinSources.reduce<readonly string[]>(
      (prev, gherkinSource) => prev.concat(buildStepTexts(gherkinSource)),
      []
    )
    await this.connection.console.info(`Found ${stepTexts.length} steps in those feature files`)
    const glueSources = await loadAll(glueGlobs)
    await this.connection.console.info(`Found ${glueSources.length} ${languageName} files`)
    const expressions = this.expressionBuilder.build(languageName, glueSources)
    await this.connection.console.info(
      `Found ${expressions.length} step definitions in those files`
    )
    return buildStepDocuments(stepTexts, expressions)
  }
}
