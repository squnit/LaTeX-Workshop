import * as vscode from 'vscode'

import type { Extension } from '../main'
import * as logger from './logger'
import { ChkTeX } from './linterlib/chktex'
import { LaCheck } from './linterlib/lacheck'
export interface ILinter {
    getName(): string,
    readonly linterDiagnostics: vscode.DiagnosticCollection,
    lintRootFile(rootPath: string): void,
    lintFile(document: vscode.TextDocument): void,
    parseLog(log: string, filePath?: string): void
}

export class Linter {
    readonly #linters: Map<string, ILinter> = new Map()
    private linterTimeout?: NodeJS.Timer

    constructor(private readonly extension: Extension) {}

    private get chktex(): ILinter {
        const linterId = 'chktex'
        const chktex = this.#linters.get(linterId) || new ChkTeX(this.extension)
        if (!this.#linters.has(linterId)) {
            this.#linters.set(linterId, chktex)
        }
        return chktex
    }

    private get lacheck(): ILinter {
        const linterId = 'lacheck'
        const lacheck = this.#linters.get(linterId) || new LaCheck(this.extension)
        if (!this.#linters.has(linterId)) {
            this.#linters.set(linterId, lacheck)
        }
        return lacheck
    }

    private getLinters(scope?: vscode.ConfigurationScope): ILinter[] {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', scope)
        const linters: ILinter[] = []
        if (configuration.get('linting.chktex.enabled')) {
            linters.push(this.chktex)
        } else {
            this.chktex.linterDiagnostics.clear()
        }
        if (configuration.get('linting.lacheck.enabled')) {
            linters.push(this.lacheck)
        } else {
            this.lacheck.linterDiagnostics.clear()
        }
        return linters
    }

    lintRootFileIfEnabled() {
        const linters = this.getLinters(this.extension.manager.getWorkspaceFolderRootDir())
        linters.forEach(linter => {
            if (this.extension.manager.rootFile === undefined) {
                logger.log(`[Linter][${linter.getName()}] No root file found.`)
                return
            }
            logger.log(`[Linter][${linter.getName()}] Linting root ${this.extension.manager.rootFile} .`)
            linter.lintRootFile(this.extension.manager.rootFile)
        })
    }

    lintActiveFileIfEnabledAfterInterval(document: vscode.TextDocument) {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', document.uri)
        const linters = this.getLinters(document.uri)
        if (linters.length > 0
            && (configuration.get('linting.run') as string) === 'onType') {
            const interval = configuration.get('linting.delay') as number
            if (this.linterTimeout) {
                clearTimeout(this.linterTimeout)
            }
            this.linterTimeout = setTimeout(() => linters.forEach(linter => {
                logger.log(`[Linter][${linter.getName()}] Linting ${document.fileName} .`)
                linter.lintFile(document)
            }), interval)
        }
    }
}
