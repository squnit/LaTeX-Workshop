import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as cp from 'child_process'
import * as cs from 'cross-spawn'
import * as os from 'os'
import * as tmp from 'tmp'

import type { Extension } from '../main'
import { replaceArgumentPlaceholders } from '../utils/utils'
import { BuildFinished } from './eventbus'
import type { IBuilder } from '../interfaces'

export class Builder implements IBuilder {
    disableBuildAfterSave: boolean = false
    readonly tmpDir: string

    private prevLangId: string | undefined
    private prevRecipe: Recipe | undefined
    private building: boolean = false
    private process: cp.ChildProcessWithoutNullStreams | undefined

    private readonly isMiktex: boolean = false
    private readonly stepQueue: BuildToolQueue = new BuildToolQueue()
    private readonly TEX_MAGIC_PROGRAM_NAME = 'TEX_MAGIC_PROGRAM_NAME'
    private readonly BIB_MAGIC_PROGRAM_NAME = 'BIB_MAGIC_PROGRAM_NAME'
    private readonly MAGIC_PROGRAM_ARGS_SUFFIX = '_WITH_ARGS'
    private readonly MAX_PRINT_LINE = '10000'

    constructor(private readonly extension: Extension) {
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
        // Check if pdflatex is available, and is MikTeX distro
        try {
            const pdflatexVersion = cp.execSync('pdflatex --version')
            if (pdflatexVersion.toString().match(/MiKTeX/)) {
                this.isMiktex = true
                this.extension.logger.addLogMessage('pdflatex is provided by MiKTeX')
            }
        } catch (e) {
            this.extension.logger.addLogMessage('Cannot run pdflatex to determine if we are using MiKTeX')
        }
    }

    kill() {
        if (this.process === undefined) {
            this.extension.logger.addLogMessage('LaTeX build process to kill is not found.')
            return
        }
        const pid = this.process.pid
        try {
            this.extension.logger.addLogMessage(`Kill child processes of the current process. PPID: ${pid}`)
            if (process.platform === 'linux' || process.platform === 'darwin') {
                cp.execSync(`pkill -P ${pid}`, { timeout: 1000 })
            } else if (process.platform === 'win32') {
                cp.execSync(`taskkill /F /T /PID ${pid}`, { timeout: 1000 })
            }
        } catch (e) {
            if (e instanceof Error) {
                this.extension.logger.addLogMessage(`Error when killing child processes of the current process. ${e.message}`)
            }
        } finally {
            this.stepQueue.clear()
            this.process.kill()
            this.extension.logger.addLogMessage(`Kill the current process. PID: ${pid}`)
        }
    }

    async buildExternal(command: string, args: string[], pwd: string, rootFile?: string) {
        if (this.building) {
            void this.extension.logger.showErrorMessageWithCompilerLogButton('Please wait for the current build to finish.')
            return
        }
        if (rootFile) {
            this.extension.manager.ignorePdfFile(rootFile)
        }

        await this.#saveAll(rootFile)

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
        const cwd = workspaceFolder?.uri.fsPath || pwd
        if (rootFile !== undefined) {
            args = args.map(replaceArgumentPlaceholders(rootFile, this.tmpDir))
        }
        const tool: Tool = { name: command, command, args }

        this.stepQueue.add(tool, rootFile, 'External', Date.now(), true, cwd)

        await this.#buildLoop()
    }

    async build(rootFile: string, langId: string, recipeName?: string) {
        this.extension.logger.addLogMessage(`Build root file ${rootFile}`)

        // Stop watching the PDF file to avoid reloading the PDF viewer twice.
        // The builder will be responsible for refreshing the viewer.
        this.extension.manager.ignorePdfFile(rootFile)

        await this.#saveAll(rootFile)

        this.#createOuputSubFolders(rootFile)

        const tools = this.#createBuildTools(rootFile, langId, recipeName)

        if (tools === undefined) {
            this.extension.logger.addLogMessage('Invalid toolchain.')
            return
        }
        const timestamp = Date.now()
        tools.forEach(tool => this.stepQueue.add(tool, rootFile, recipeName || 'Build', timestamp))

        await this.#buildLoop()
    }

    async #saveAll(rootFile?: string) {
        this.disableBuildAfterSave = true
        await vscode.workspace.saveAll()
        const configuration = vscode.workspace.getConfiguration('latex-workshop', rootFile ? vscode.Uri.file(rootFile) : undefined)
        setTimeout(() => this.disableBuildAfterSave = false, configuration.get('latex.autoBuild.interval', 1000) as number)
    }

    async #buildLoop() {
        if (this.building) {
            return
        }
        this.building = true
        while (true) {
            const step = this.stepQueue.getStep()
            if (step === undefined) {
                break
            }
            const env = this.#spawnProcess(step)
            await this.#monitorProcess(step, env)
            if (this.stepQueue.isLastStep(step)) {
                await this.#afterBuilt(step)
            }
        }
        this.building = false
    }

    #spawnProcess(step: Step, cwd?: string): ProcessEnv {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', step.rootFile ? vscode.Uri.file(step.rootFile) : undefined)
        if (step.index === 0 || configuration.get('latex.build.clearLog.everyRecipeStep.enabled') as boolean) {
            this.extension.logger.clearCompilerMessage()
        }
        this.extension.logger.displayStatus('sync~spin', 'statusBar.foreground', undefined, undefined, ' ' + this.stepQueue.getStepString(step))
        this.extension.logger.logCommand(`Recipe step ${step.index + 1}`, step.command, step.args)
        this.extension.logger.addLogMessage(`Recipe step env: ${JSON.stringify(step.env)}`)
        this.extension.logger.addLogMessage(`Recipe step root file: ${step.rootFile}`)

        const env = Object.create(null) as ProcessEnv
        Object.keys(process.env).forEach(key => env[key] = process.env[key])
        const toolEnv = step.env
        if (toolEnv) {
            Object.keys(toolEnv).forEach(key => env[key] = toolEnv[key])
        }
        env['max_print_line'] = this.MAX_PRINT_LINE

        if (!step.isExternal &&
            (step.name.startsWith(this.TEX_MAGIC_PROGRAM_NAME) ||
             step.name.startsWith(this.BIB_MAGIC_PROGRAM_NAME))) {
            this.extension.logger.addLogMessage(`cwd: ${path.dirname(step.rootFile)}`)

            const args = step.args
            if (args && !step.name.endsWith(this.MAGIC_PROGRAM_ARGS_SUFFIX)) {
                // All optional arguments are given as a unique string (% !TeX options) if any, so we use {shell: true}
                this.process = cs.spawn(`${step.command} ${args[0]}`, [], {cwd: path.dirname(step.rootFile), env, shell: true})
            } else {
                this.process = cs.spawn(step.command, args, {cwd: path.dirname(step.rootFile), env})
            }
        } else if (!step.isExternal) {
            if (step.command === 'latexmk' && step.rootFile === this.extension.manager.localRootFile && this.extension.manager.rootDir) {
                cwd = this.extension.manager.rootDir
            } else {
                cwd = path.dirname(step.rootFile)
            }
            this.extension.logger.addLogMessage(`cwd: ${cwd}`)
            this.process = cs.spawn(step.command, step.args, {cwd, env})
        } else {
            this.extension.logger.logCommand('Build using external command', step.command, step.args)
            this.extension.logger.addLogMessage(`cwd: ${step.cwd}`)
            this.process = cs.spawn(step.command, step.args, {cwd: step.cwd})
        }
        this.extension.logger.addLogMessage(`LaTeX build process spawned. PID: ${this.process.pid}.`)
        return env
    }

    async #monitorProcess(step: Step, env: ProcessEnv) {
        if (this.process === undefined) {
            return
        }
        let stdout = ''
        this.process.stdout.on('data', (msg: Buffer | string) => {
            stdout += msg
            this.extension.logger.addCompilerMessage(msg.toString())
        })

        let stderr = ''
        this.process.stderr.on('data', (msg: Buffer | string) => {
            stderr += msg
            this.extension.logger.addCompilerMessage(msg.toString())
        })

        await new Promise(resolve => {
            if (this.process === undefined) {
                resolve(0)
                return
            }
            this.process.on('error', err => {
                this.extension.logger.addLogMessage(`LaTeX fatal error: ${err.message}, ${stderr}. PID: ${this.process?.pid}.`)
                this.extension.logger.addLogMessage(`Does the executable exist? $PATH: ${env['PATH']}`)
                this.extension.logger.addLogMessage(`Does the executable exist? $Path: ${env['Path']}`)
                this.extension.logger.addLogMessage(`The environment variable $SHELL: ${process.env.SHELL}`)
                this.extension.logger.displayStatus('x', 'errorForeground', undefined, 'error')
                void this.extension.logger.showErrorMessageWithExtensionLogButton(`Recipe terminated with fatal error: ${err.message}.`)
                this.process = undefined
                this.stepQueue.clear()
                resolve(0)
            })

            this.process.on('exit', async (code, signal) => {
                this.extension.compilerLogParser.parse(stdout, step.rootFile)
                if (!step.isExternal && code === 0) {
                    this.extension.logger.addLogMessage(`A step in recipe finished. PID: ${this.process?.pid}.`)
                    this.process = undefined
                    resolve(0)
                    return
                } else if (code === 0) {
                    this.extension.logger.addLogMessage(`Successfully built. PID: ${this.process?.pid}`)
                    this.extension.logger.displayStatus('check', 'statusBar.foreground', 'Build succeeded.')
                    if (step.rootFile === undefined) {
                        this.extension.viewer.refreshExistingViewer()
                    }
                    this.process = undefined
                    resolve(0)
                    return
                }

                if (!step.isExternal) {
                    this.extension.logger.addLogMessage(`Recipe returns with error: ${code}/${signal}. PID: ${this.process?.pid}. message: ${stderr}.`)
                    this.extension.logger.addLogMessage(`Does the executable exist? $PATH: ${env['PATH']}`)
                    this.extension.logger.addLogMessage(`Does the executable exist? $Path: ${env['Path']}`)
                    this.extension.logger.addLogMessage(`The environment variable $SHELL: ${process.env.SHELL}`)
                }

                const configuration = vscode.workspace.getConfiguration('latex-workshop', step.rootFile ? vscode.Uri.file(step.rootFile) : undefined)
                if (!step.isExternal && signal !== 'SIGTERM' && !step.isRetry && configuration.get('latex.autoBuild.cleanAndRetry.enabled')) {
                    // Recipe, not terminated by user, is not retry and should retry
                    step.isRetry = true
                    this.extension.logger.displayStatus('x', 'errorForeground', 'Recipe terminated with error. Retry building the project.', 'warning')
                    this.extension.logger.addLogMessage('Cleaning auxiliary files and retrying build after toolchain error.')

                    this.stepQueue.prepend(step)
                    await this.extension.cleaner.clean(step.rootFile)
                } else if (!step.isExternal && signal !== 'SIGTERM') {
                    // Recipe, not terminated by user, is retry or should not retry
                    this.extension.logger.displayStatus('x', 'errorForeground')
                    if (['onFailed', 'onBuilt'].includes(configuration.get('latex.autoClean.run') as string)) {
                        await this.extension.cleaner.clean(step.rootFile)
                    }
                    void this.extension.logger.showErrorMessageWithCompilerLogButton('Recipe terminated with error.')
                    this.stepQueue.clear()
                } else if (step.isExternal) {
                    // External command
                    this.extension.logger.addLogMessage(`Build returns with error: ${code}/${signal}. PID: ${this.process?.pid}.`)
                    this.extension.logger.displayStatus('x', 'errorForeground', undefined, 'warning')
                    void this.extension.logger.showErrorMessageWithCompilerLogButton('Build terminated with error.')
                    this.stepQueue.clear()
                } else {
                    // Terminated by user
                    this.extension.logger.displayStatus('x', 'errorForeground')
                    this.stepQueue.clear()
                }
                this.process = undefined
                resolve(0)
            })
        })
    }

    async #afterBuilt(step: Step) {
        if (step.rootFile === undefined) {
            // This only happens when the step is an external command.
            return
        }
        this.extension.logger.addLogMessage(`Successfully built ${step.rootFile}.`)
        this.extension.logger.displayStatus('check', 'statusBar.foreground', 'Recipe succeeded.')
        this.extension.eventBus.fire(BuildFinished)
        if (this.extension.compilerLogParser.isLaTeXmkSkipped) {
            return
        }
        this.extension.viewer.refreshExistingViewer(step.rootFile)
        this.extension.completer.reference.setNumbersFromAuxFile(step.rootFile)
        await this.extension.manager.parseFlsFile(step.rootFile)
        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(step.rootFile))
        // If the PDF viewer is internal, we call SyncTeX in src/components/viewer.ts.
        if (configuration.get('view.pdf.viewer') === 'external' && configuration.get('synctex.afterBuild.enabled')) {
            const pdfFile = this.extension.manager.tex2pdf(step.rootFile)
            this.extension.logger.addLogMessage('SyncTex after build invoked.')
            this.extension.locator.syncTeX(undefined, undefined, pdfFile)
        }
        if (configuration.get('latex.autoClean.run') as string === 'onBuilt') {
            this.extension.logger.addLogMessage('Auto Clean invoked.')
            await this.extension.cleaner.clean(step.rootFile)
        }
    }

    #createBuildTools(rootFile: string, langId: string, recipeName?: string): Tool[] | undefined {
        let buildTools: Tool[] = []

        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(rootFile))
        const [magicTex, magicBib] = this.#findMagicPrograms(rootFile)

        if (recipeName === undefined && magicTex && !configuration.get('latex.build.forceRecipeUsage')) {
            buildTools = this.#createBuildMagic(rootFile, magicTex, magicBib)
        } else {
            const recipe = this.#findRecipe(rootFile, langId, recipeName)
            if (recipe === undefined) {
                return undefined
            }
            this.prevRecipe = recipe
            this.prevLangId = langId
            const tools = configuration.get('latex.tools') as Tool[]
            recipe.tools.forEach(tool => {
                if (typeof tool === 'string') {
                    const candidates = tools.filter(candidate => candidate.name === tool)
                    if (candidates.length < 1) {
                        this.extension.logger.addLogMessage(`Skipping undefined tool: ${tool} in ${recipe?.name}`)
                        void this.extension.logger.showErrorMessage(`Skipping undefined tool "${tool}" in recipe "${recipe?.name}."`)
                    } else {
                        buildTools.push(candidates[0])
                    }
                } else {
                    buildTools.push(tool)
                }
            })
        }
        if (buildTools.length < 1) {
            return undefined
        }

        // Use JSON.parse and JSON.stringify for a deep copy.
        buildTools = JSON.parse(JSON.stringify(buildTools)) as Tool[]

        this.#populateTools(rootFile, buildTools)

        return buildTools
    }

    #populateTools(rootFile: string, buildTools: Tool[]): Tool[] {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(rootFile))
        const docker = configuration.get('docker.enabled')

        buildTools.forEach(tool => {
            if (docker) {
                switch (tool.command) {
                    case 'latexmk':
                        this.extension.logger.addLogMessage('Use Docker to invoke the command.')
                        if (process.platform === 'win32') {
                            tool.command = path.resolve(this.extension.extensionRoot, './scripts/latexmk.bat')
                        } else {
                            tool.command = path.resolve(this.extension.extensionRoot, './scripts/latexmk')
                            fs.chmodSync(tool.command, 0o755)
                        }
                        break
                    default:
                        this.extension.logger.addLogMessage(`Will not use Docker to invoke the command: ${tool.command}`)
                        break
                }
            }
            if (tool.args) {
                tool.args = tool.args.map(replaceArgumentPlaceholders(rootFile, this.tmpDir))
            }
            if (tool.env) {
                Object.keys(tool.env).forEach( v => {
                    const e = tool.env && tool.env[v]
                    if (tool.env && e) {
                        tool.env[v] = replaceArgumentPlaceholders(rootFile, this.tmpDir)(e)
                    }
                })
            }
            if (configuration.get('latex.option.maxPrintLine.enabled')) {
                if (!tool.args) {
                    tool.args = []
                }
                const isLuaLatex = tool.args.includes('-lualatex') ||
                                   tool.args.includes('-pdflua') ||
                                   tool.args.includes('-pdflualatex') ||
                                   tool.args.includes('--lualatex') ||
                                   tool.args.includes('--pdflua') ||
                                   tool.args.includes('--pdflualatex')
                if (this.isMiktex && ((tool.command === 'latexmk' && !isLuaLatex) || tool.command === 'pdflatex')) {
                    tool.args.unshift('--max-print-line=' + this.MAX_PRINT_LINE)
                }
            }
        })
        return buildTools
    }

    #findRecipe(rootFile: string, langId: string, recipeName?: string): Recipe | undefined {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(rootFile))

        const recipes = configuration.get('latex.recipes') as Recipe[]
        const defaultRecipeName = configuration.get('latex.recipe.default') as string

        if (recipes.length < 1) {
            this.extension.logger.addLogMessage('No recipes defined.')
            void this.extension.logger.showErrorMessage('No recipes defined.')
            return undefined
        }
        if (this.prevLangId !== langId) {
            this.prevRecipe = undefined
        }
        let recipe: Recipe | undefined
        // Find recipe according to the given name
        if (recipeName === undefined && !['first', 'lastUsed'].includes(defaultRecipeName)) {
            recipeName = defaultRecipeName
        }
        if (recipeName) {
            const candidates = recipes.filter(candidate => candidate.name === recipeName)
            if (candidates.length < 1) {
                this.extension.logger.addLogMessage(`Failed to resolve build recipe: ${recipeName}`)
                void this.extension.logger.showErrorMessage(`Failed to resolve build recipe: ${recipeName}`)
            }
            recipe = candidates[0]
        }
        // Find default recipe of last used
        if (recipe === undefined && defaultRecipeName === 'lastUsed') {
            recipe = this.prevRecipe
        }
        // If still not found, fallback to 'first'
        if (recipe === undefined) {
            let candidates: Recipe[] = recipes
            if (langId === 'rsweave') {
                 candidates = recipes.filter(candidate => candidate.name.toLowerCase().match('rnw|rsweave'))
            } else if (langId === 'jlweave') {
                 candidates = recipes.filter(candidate => candidate.name.toLowerCase().match('jnw|jlweave|weave.jl'))
            }
             if (candidates.length < 1) {
                 this.extension.logger.addLogMessage(`Failed to resolve build recipe: ${recipeName}`)
                 void this.extension.logger.showErrorMessage(`Failed to resolve build recipe: ${recipeName}`)
             }
             recipe = candidates[0]
        }
        return recipe
    }

    #createBuildMagic(rootFile: string, magicTex: Tool, magicBib?: Tool): Tool[] {
        const configuration = vscode.workspace.getConfiguration('latex-workshop', vscode.Uri.file(rootFile))

        if (!magicTex.args) {
            magicTex.args = configuration.get('latex.magic.args') as string[]
            magicTex.name = this.TEX_MAGIC_PROGRAM_NAME + this.MAGIC_PROGRAM_ARGS_SUFFIX
        }
        if (magicBib) {
            if (!magicBib.args) {
                magicBib.args = configuration.get('latex.magic.bib.args') as string[]
                magicBib.name = this.BIB_MAGIC_PROGRAM_NAME + this.MAGIC_PROGRAM_ARGS_SUFFIX
            }
            return [magicTex, magicBib, magicTex, magicTex]
        } else {
            return [magicTex]
        }
    }

    #findMagicPrograms(rootFile: string): [Tool | undefined, Tool | undefined] {
        const regexTex = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
        const regexBib = /^(?:%\s*!\s*BIB\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
        const regexTexOptions = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?options\s*=\s*(.*)$)/m
        const regexBibOptions = /^(?:%\s*!\s*BIB\s(?:TS-)?options\s*=\s*(.*)$)/m
        const content = fs.readFileSync(rootFile).toString()

        const tex = content.match(regexTex)
        const bib = content.match(regexBib)
        let texCommand: Tool | undefined = undefined
        let bibCommand: Tool | undefined = undefined

        if (tex) {
            texCommand = {
                name: this.TEX_MAGIC_PROGRAM_NAME,
                command: tex[1]
            }
            this.extension.logger.addLogMessage(`Found TeX program by magic comment: ${texCommand.command}`)
            const res = content.match(regexTexOptions)
            if (res) {
                texCommand.args = [res[1]]
                this.extension.logger.addLogMessage(`Found TeX options by magic comment: ${texCommand.args}`)
            }
        }

        if (bib) {
            bibCommand = {
                name: this.BIB_MAGIC_PROGRAM_NAME,
                command: bib[1]
            }
            this.extension.logger.addLogMessage(`Found BIB program by magic comment: ${bibCommand.command}`)
            const res = content.match(regexBibOptions)
            if (res) {
                bibCommand.args = [res[1]]
                this.extension.logger.addLogMessage(`Found BIB options by magic comment: ${bibCommand.args}`)
            }
        }

        return [texCommand, bibCommand]
    }

    /**
     * Create sub directories of output directory This was supposed to create
     * the outputDir as latexmk does not take care of it (neither does any of
     * latex command). If the output directory does not exist, the latex
     * commands simply fail.
     */
    #createOuputSubFolders(rootFile: string) {
        const rootDir = path.dirname(rootFile)
        let outDir = this.extension.manager.getOutDir(rootFile)
        if (!path.isAbsolute(outDir)) {
            outDir = path.resolve(rootDir, outDir)
        }
        this.extension.logger.addLogMessage(`outDir: ${outDir}`)
        try {
            this.extension.manager.getIncludedTeX(rootFile).forEach(file => {
                const relativePath = path.dirname(file.replace(rootDir, '.'))
                const fullOutDir = path.resolve(outDir, relativePath)
                // To avoid issues when fullOutDir is the root dir
                // Using fs.mkdir() on the root directory even with recursion will result in an error
                if (! (fs.existsSync(fullOutDir) && fs.statSync(fullOutDir).isDirectory())) {
                    fs.mkdirSync(fullOutDir, { recursive: true })
                }
            })
        } catch (e) {
            this.extension.logger.addLogMessage('Unexpected Error: please see the console log of the Developer Tools of VS Code.')
            this.extension.logger.displayStatus('x', 'errorForeground')
            throw(e)
        }
    }
}

class BuildToolQueue {
    #steps: Step[] = []
    #nextSteps: Step[] = []

    constructor() {}

    add(tool: Tool, rootFile: string | undefined, recipeName: string, timestamp: number, isExternal: boolean = false, cwd?: string) {
        let step: RecipeStep | ExternalStep
        if (!isExternal && rootFile !== undefined) {
            step = tool as RecipeStep
            step.rootFile = rootFile
            step.recipeName = recipeName
            step.timestamp = timestamp
            step.isRetry = false
            step.isExternal = false
        } else {
            step = tool as ExternalStep
            step.recipeName = 'External'
            step.timestamp = timestamp
            step.isExternal = true
            step.cwd = cwd || ''
        }
        if (this.#steps.length === 0 || step.timestamp === this.#steps[0].timestamp) {
            step.index = (this.#steps[0]?.timestamp || -1) + 1
            this.#steps.push(step)
        } else if (this.#nextSteps.length === 0 || step.timestamp === this.#nextSteps[0].timestamp){
            step.index = (this.#nextSteps[0]?.timestamp || -1) + 1
            this.#nextSteps.push(step)
        } else {
            step.index = 0
            this.#nextSteps = [ step ]
        }
    }

    prepend(step: Step) {
        this.#steps.unshift(step)
    }

    clear() {
        this.#nextSteps = []
        this.#steps = []
    }

    isLastStep(step: Step) {
        return this.#steps.length === 0 || this.#steps[0].timestamp !== step.timestamp
    }

    getStepString(step: Step): string {
        if (step.timestamp !== this.#steps[0]?.timestamp && step.index === 0) {
            return step.recipeName
        } else if (step.timestamp === this.#steps[0]?.timestamp) {
            return `${step.recipeName}: ${step.index + 1}/${this.#steps[this.#steps.length - 1].index + 1} (${step.name})`
        } else {
            return `${step.recipeName}: ${step.index + 1}/${step.index + 1} (${step.name})`
        }
    }

    getStep(): Step | undefined {
        let step: Step | undefined
        if (this.#steps.length > 0) {
            step = this.#steps.shift()
        } else if (this.#nextSteps.length > 0) {
            this.#steps = this.#nextSteps
            this.#nextSteps = []
            step = this.#steps.shift()
        }
        return step
    }
}

interface ProcessEnv {
    [key: string]: string | undefined
}

interface Tool {
    name: string,
    command: string,
    args?: string[],
    env?: ProcessEnv
}

interface Recipe {
    name: string,
    tools: (string | Tool)[]
}

interface RecipeStep extends Tool {
    rootFile: string,
    recipeName: string,
    timestamp: number,
    index: number,
    isExternal: false,
    isRetry: boolean
}

interface ExternalStep extends Tool {
    rootFile?: string,
    recipeName: 'External',
    timestamp: number,
    index: number,
    isExternal: true,
    cwd: string
}

type Step = RecipeStep | ExternalStep
