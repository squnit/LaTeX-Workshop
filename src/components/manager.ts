import * as vscode from 'vscode'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import * as tmp from 'tmp'
import * as utils from '../utils/utils'
import * as lw from '../lw'
import * as eventbus from './eventbus'
import { FinderUtils } from './managerlib/finderutils'
import { getLogger } from './logger'

const logger = getLogger('Manager')

type RootFileType = {
    type: 'filePath',
    filePath: string
} | {
    type: 'uri',
    uri: vscode.Uri
}

export const TEX_EXT: string[] = ['.tex', '.bib']
export const RSWEAVE_EXT: string[] = ['.rnw', '.Rnw', '.rtex', '.Rtex', '.snw', '.Snw']
export const JLWEAVE_EXT: string[] = ['.jnw', '.jtexw']
export const PWEAVE_EXT: string[] = ['.pnw', '.ptexw']

export class Manager {
    private _localRootFile: string | undefined
    private _rootFileLanguageId: string | undefined
    private _rootFile: RootFileType | undefined
    readonly tmpDir: string

    constructor() {
        this.registerSetEnvVar()

        // Create temp folder
        try {
            this.tmpDir = tmp.dirSync({unsafeCleanup: true}).name.split(path.sep).join('/')
        } catch (error) {
            void vscode.window.showErrorMessage('Error during making tmpdir to build TeX files. Please check the environment variables, TEMP, TMP, and TMPDIR on your system.')
            console.log(`TEMP, TMP, and TMPDIR: ${JSON.stringify([process.env.TEMP, process.env.TMP, process.env.TMPDIR])}`)
            // https://github.com/James-Yu/LaTeX-Workshop/issues/2911#issuecomment-944318278
            if (/['"]/.exec(os.tmpdir())) {
                const msg = `The path of tmpdir cannot include single quotes and double quotes: ${os.tmpdir()}`
                void vscode.window.showErrorMessage(msg)
                console.log(msg)
            }
            throw error
        }
    }

    /**
     * Returns the output directory developed according to the input tex path
     * and 'latex.outDir' config. If `texPath` is `undefined`, the default root
     * file is used. If there is not root file, returns './'.
     * The returned path always uses `/` even on Windows.
     *
     * @param texPath The path of a LaTeX file.
     */
    getOutDir(texPath?: string) {
        if (texPath === undefined) {
            texPath = this.rootFile
        }
        // rootFile is also undefined
        if (texPath === undefined) {
            return './'
        }

        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(texPath))
        const outDir = configuration.get('latex.outDir') as string
        const out = utils.replaceArgumentPlaceholders(texPath, this.tmpDir)(outDir)
        return path.normalize(out).split(path.sep).join('/')
    }

    /**
     * The path of the directory of the root file.
     */
    get rootDir() {
        return this.rootFile ? path.dirname(this.rootFile) : undefined
    }

    /**
     * The path of the root LaTeX file of the current workspace.
     * It is `undefined` before `findRoot` called.
     */
    get rootFile(): string | undefined {
        const ret = this._rootFile
        if (ret) {
            if (ret.type === 'filePath') {
                return ret.filePath
            } else {
                if (ret.uri.scheme === 'file') {
                    return ret.uri.fsPath
                } else {
                    logger.log(`The file cannot be used as the root file: ${ret.uri.toString(true)}`)
                    return
                }
            }
        } else {
            return
        }
    }

    set rootFile(root: string | undefined) {
        if (root) {
            this._rootFile = { type: 'filePath', filePath: root }
        } else {
            this._rootFile = undefined
        }
    }

    get rootFileUri(): vscode.Uri | undefined {
        const root = this._rootFile
        if (root) {
            if (root.type === 'filePath') {
                return vscode.Uri.file(root.filePath)
            } else {
                return root.uri
            }
        } else {
            return
        }
    }

    set rootFileUri(root: vscode.Uri | undefined) {
        let rootFile: RootFileType | undefined
        if (root) {
            if (root.scheme === 'file') {
                rootFile = { type: 'filePath', filePath: root.fsPath }
            } else {
                rootFile = { type: 'uri', uri: root }
            }
        }
        this._rootFile = rootFile
    }

    get localRootFile() {
        return this._localRootFile
    }

    set localRootFile(localRoot: string | undefined) {
        this._localRootFile = localRoot
    }

    get rootFileLanguageId() {
        return this._rootFileLanguageId
    }

    set rootFileLanguageId(id: string | undefined) {
        this._rootFileLanguageId = id
    }

    getWorkspaceFolderRootDir(): vscode.WorkspaceFolder | undefined {
        const rootFileUri = this.rootFileUri
        if (rootFileUri) {
            return vscode.workspace.getWorkspaceFolder(rootFileUri)
        }
        return undefined
    }

    private inferLanguageId(filename: string): string | undefined {
        const ext = path.extname(filename).toLocaleLowerCase()
        if (ext === '.tex') {
            return 'latex'
        } else if (PWEAVE_EXT.includes(ext)) {
            return 'pweave'
        } else if (JLWEAVE_EXT.includes(ext)) {
            return 'jlweave'
        } else if (RSWEAVE_EXT.includes(ext)) {
            return 'rsweave'
        } else if (ext === '.dtx') {
            return 'doctex'
        } else {
            return undefined
        }
    }

    /**
     * Returns the path of a PDF file with respect to `texPath`.
     *
     * @param texPath The path of a LaTeX file.
     * @param respectOutDir If `true`, the 'latex.outDir' config is respected.
     */
    tex2pdf(texPath: string, respectOutDir: boolean = true) {
        let outDir = './'
        if (respectOutDir) {
            outDir = this.getOutDir(texPath)
        }
        return path.resolve(path.dirname(texPath), outDir, path.basename(`${texPath.substring(0, texPath.lastIndexOf('.'))}.pdf`))
    }

    /**
     * Returns `true` if the language of `id` is one of supported languages.
     *
     * @param id The language identifier
     */
    hasTexId(id: string) {
        return ['tex', 'latex', 'latex-expl3', 'doctex', 'pweave', 'jlweave', 'rsweave'].includes(id)
    }

    /**
     * Returns `true` if the language of `id` is bibtex
     *
     * @param id The language identifier
     */
    hasBibtexId(id: string) {
        return id === 'bibtex'
    }


    private findWorkspace(): vscode.Uri | undefined {
        const firstDir = vscode.workspace.workspaceFolders?.[0]
        // If no workspace is opened.
        if (!firstDir) {
            return undefined
        }
        // If we don't have an active text editor, we can only make a guess.
        // Let's guess the first one.
        if (!vscode.window.activeTextEditor) {
            return firstDir.uri
        }
        // Get the workspace folder which contains the active document.
        const activeFileUri = vscode.window.activeTextEditor.document.uri
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeFileUri)
        if (workspaceFolder) {
            return workspaceFolder.uri
        }
        // Guess that the first workspace is the chosen one.
        return firstDir.uri
    }

    /**
     * Finds the root file with respect to the current workspace and returns it.
     * The found root is also set to `rootFile`.
     */
    async findRoot(): Promise<string | undefined> {
        const wsfolders = vscode.workspace.workspaceFolders?.map(e => e.uri.toString(true))
        logger.log(`Current workspace folders: ${JSON.stringify(wsfolders)}`)
        this.localRootFile = undefined
        const findMethods = [
            () => FinderUtils.findRootFromMagic(),
            () => this.findRootFromActive(),
            () => this.findRootFromCurrentRoot(),
            () => this.findRootInWorkspace()
        ]
        for (const method of findMethods) {
            const rootFile = await method()
            if (rootFile === undefined) {
                continue
            }
            if (this.rootFile !== rootFile) {
                logger.log(`Root file changed: from ${this.rootFile} to ${rootFile}`)
                logger.log('Start to find all dependencies.')
                this.rootFile = rootFile
                this.rootFileLanguageId = this.inferLanguageId(rootFile)
                logger.log(`Root file languageId: ${this.rootFileLanguageId}`)
                // We also clean the completions from the old project
                lw.completer.input.reset()
                lw.duplicateLabels.reset()
                await lw.cacher.resetWatcher()
                lw.cacher.add(this.rootFile)
                await lw.cacher.refreshContext(this.rootFile)
                // await this.initiateFileWatcher()
                // await this.parseFileAndSubs(this.rootFile, this.rootFile) // Finishing the parsing is required for subsequent refreshes.
                // We need to parse the fls to discover file dependencies when defined by TeX macro
                // It happens a lot with subfiles, https://tex.stackexchange.com/questions/289450/path-of-figures-in-different-directories-with-subfile-latex
                await lw.cacher.loadFlsFile(this.rootFile)
                lw.eventBus.fire(eventbus.RootFileChanged, rootFile)
            } else {
                logger.log(`Keep using the same root file: ${this.rootFile}`)
            }
            lw.eventBus.fire(eventbus.RootFileSearched)
            return rootFile
        }
        lw.eventBus.fire(eventbus.RootFileSearched)
        return undefined
    }

    private findRootFromCurrentRoot(): string | undefined {
        if (!vscode.window.activeTextEditor || this.rootFile === undefined) {
            return undefined
        }
        if (lw.lwfs.isVirtualUri(vscode.window.activeTextEditor.document.uri)) {
            logger.log(`The active document cannot be used as the root file: ${vscode.window.activeTextEditor.document.uri.toString(true)}`)
            return undefined
        }
        if (lw.cacher.getIncludedTeX().includes(vscode.window.activeTextEditor.document.fileName)) {
            return this.rootFile
        }
        return undefined
    }

    private findRootFromActive(): string | undefined {
        if (!vscode.window.activeTextEditor) {
            return undefined
        }
        if (lw.lwfs.isVirtualUri(vscode.window.activeTextEditor.document.uri)) {
            logger.log(`The active document cannot be used as the root file: ${vscode.window.activeTextEditor.document.uri.toString(true)}`)
            return undefined
        }
        const regex = /\\begin{document}/m
        const content = utils.stripCommentsAndVerbatim(vscode.window.activeTextEditor.document.getText())
        const result = content.match(regex)
        if (result) {
            const rootSubFile = FinderUtils.findSubFiles(content)
            const file = vscode.window.activeTextEditor.document.fileName
            if (rootSubFile) {
               this.localRootFile = file
               return rootSubFile
            } else {
                logger.log(`Found root file from active editor: ${file}`)
                return file
            }
        }
        return undefined
    }

    private async findRootInWorkspace(): Promise<string | undefined> {
        const regex = /\\begin{document}/m
        const currentWorkspaceDirUri = this.findWorkspace()
        logger.log(`Current workspaceRootDir: ${currentWorkspaceDirUri ? currentWorkspaceDirUri.toString(true) : ''}`)

        if (!currentWorkspaceDirUri) {
            return undefined
        }

        const configuration = vscode.workspace.getConfiguration('latex-workshop', currentWorkspaceDirUri)
        const rootFilesIncludePatterns = configuration.get('latex.search.rootFiles.include') as string[]
        const rootFilesIncludeGlob = '{' + rootFilesIncludePatterns.join(',') + '}'
        const rootFilesExcludePatterns = configuration.get('latex.search.rootFiles.exclude') as string[]
        const rootFilesExcludeGlob = rootFilesExcludePatterns.length > 0 ? '{' + rootFilesExcludePatterns.join(',') + '}' : undefined
        try {
            const files = await vscode.workspace.findFiles(rootFilesIncludeGlob, rootFilesExcludeGlob)
            const candidates: string[] = []
            for (const file of files) {
                if (lw.lwfs.isVirtualUri(file)) {
                    logger.log(`Skip the file: ${file.toString(true)}`)
                    continue
                }
                const flsChildren = lw.cacher.getTeXChildrenFromFls(file.fsPath)
                if (vscode.window.activeTextEditor && flsChildren.includes(vscode.window.activeTextEditor.document.fileName)) {
                    logger.log(`Found root file from '.fls': ${file.fsPath}`)
                    return file.fsPath
                }
                const content = utils.stripCommentsAndVerbatim(fs.readFileSync(file.fsPath).toString())
                const result = content.match(regex)
                if (result) {
                    // Can be a root
                    const children = await lw.cacher.getTeXChildren(file.fsPath, file.fsPath, [])
                    if (vscode.window.activeTextEditor && children.includes(vscode.window.activeTextEditor.document.fileName)) {
                        logger.log(`Found root file from parent: ${file.fsPath}`)
                        return file.fsPath
                    }
                    // Not including the active file, yet can still be a root candidate
                    candidates.push(file.fsPath)
                }
            }
            if (candidates.length > 0) {
                logger.log(`Found files that might be root, choose the first one: ${candidates}`)
                return candidates[0]
            }
        } catch (e) {}
        return undefined
    }

    private registerSetEnvVar() {
        const setEnvVar = () => {
            const configuration = vscode.workspace.getConfiguration('latex-workshop')
            const dockerImageName: string = configuration.get('docker.image.latex', '')
            logger.log(`Set $LATEXWORKSHOP_DOCKER_LATEX: ${JSON.stringify(dockerImageName)}`)
            process.env['LATEXWORKSHOP_DOCKER_LATEX'] = dockerImageName
        }
        setEnvVar()

        vscode.workspace.onDidChangeConfiguration((ev) => {
            if (ev.affectsConfiguration('latex-workshop.docker.image.latex')) {
                setEnvVar()
            }
        })
    }

}
