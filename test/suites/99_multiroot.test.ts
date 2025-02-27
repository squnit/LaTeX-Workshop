import * as vscode from 'vscode'
import * as path from 'path'
import rimraf from 'rimraf'
import * as assert from 'assert'
import * as lw from '../../src/lw'
import { sleep, runTest, assertBuild, assertAutoBuild, writeTestFile, loadTestFile, getIntellisense, assertRoot, openActive } from './utils'

suite('Multi-root workspace test suite', () => {

    const suiteName = path.basename(__filename).replace('.test.js', '')
    let fixture = path.resolve(__dirname, '../../../test/fixtures/multiroot')
    const fixtureName = 'multiroot'

    suiteSetup(() => {
        fixture = path.resolve(lw.extensionRoot, 'test/fixtures/multiroot')
    })

    setup(async () => {
        await vscode.commands.executeCommand('latex-workshop.activate')
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.autoBuild.interval', 250)
    })

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        lw.manager.rootFile = undefined

        await vscode.workspace.getConfiguration('latex-workshop').update('latex.tools', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.outDir', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.recipes', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.build.forceRecipeUsage', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.search.rootFiles.include', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.search.rootFiles.exclude', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.autoBuild.run', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('intellisense.citation.label', undefined)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.autoBuild.interval', undefined)

        if (path.basename(fixture) === 'multiroot') {
            rimraf(fixture + '/{A,B}/{*,.vscode/*}', (e) => {if (e) {console.error(e)}})
            await sleep(500) // Required for pooling
        }
    })

    runTest({suiteName, fixtureName, testName: 'basic build A'}, async () => {
        const tools = [
            {name: 'latexmk', command: 'latexmk', args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-pdf', '-outdir=%OUTDIR%', '-jobname=wsA', '%DOC%'], env: {}},
            {name: 'fake', command: 'touch', args: ['%DIR%/fake.pdf']}
        ]
        const recipes = [{name: 'latexmk', tools: ['latexmk']}]
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.tools', tools)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.recipes', recipes)
        await loadTestFile(fixture, [
            {src: 'base.tex', dst: 'A/main.tex'},
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertBuild({fixture, texName: 'A/main.tex', pdfName: 'A/wsA.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'basic build B'}, async () => {
        const tools = [
            {name: 'latexmk', command: 'latexmk', args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-pdf', '-outdir=%OUTDIR%', '-jobname=wsB', '%DOC%'], env: {}},
            {name: 'fake', command: 'touch', args: ['%DIR%/fake.pdf']}
        ]
        const recipes = [{name: 'latexmk', tools: ['latexmk']}]
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.tools', tools)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.recipes', recipes)
        await loadTestFile(fixture, [
            {src: 'base.tex', dst: 'B/main.tex'},
            {src: 'empty', dst: 'A/empty'}
        ])
        await assertBuild({fixture, texName: 'B/main.tex', pdfName: 'B/wsB.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'basic build with outDir A'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.outDir', './out')
        await loadTestFile(fixture, [
            {src: 'base.tex', dst: 'A/main.tex'},
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertBuild({fixture, texName: 'A/main.tex', pdfName: 'A/out/main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'basic build with outDir B'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.outDir', './out')
        await loadTestFile(fixture, [
            {src: 'base.tex', dst: 'B/main.tex'},
            {src: 'empty', dst: 'A/empty'}
        ])
        await assertBuild({fixture, texName: 'B/main.tex', pdfName: 'B/out/main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'build with forceRecipeUsage: true'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.build.forceRecipeUsage', true)
        await loadTestFile(fixture, [{src: 'magic_invalid.tex', dst: 'A/main.tex'}])
        await loadTestFile(fixture, [
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertBuild({fixture, texName: 'A/main.tex', pdfName: 'A/main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'detect root with search.rootFiles.include'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.search.rootFiles.include', ['alt/*.tex'])
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'A/main.tex'},
            {src: 'input_parentsub.tex', dst: 'A/alt/main.tex'},
            {src: 'plain.tex', dst: 'A/sub/s.tex'}
        ])
        await loadTestFile(fixture, [
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertRoot({fixture, openName: 'A/sub/s.tex', rootName: 'A/alt/main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'detect root with search.rootFiles.exclude'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.search.rootFiles.exclude', ['*.tex'])
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'A/main.tex'},
            {src: 'input_parentsub.tex', dst: 'A/alt/main.tex'},
            {src: 'plain.tex', dst: 'A/sub/s.tex'}
        ])
        await loadTestFile(fixture, [
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertRoot({fixture, openName: 'A/sub/s.tex', rootName: 'A/alt/main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'auto-detect subfile root and build A1'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', true)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'A/main.tex'},
            {src: 'subfile_sub.tex', dst: 'A/sub/s.tex'},
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertBuild({fixture, texName: 'A/sub/s.tex', pdfName: 'A/sub/s.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'auto-detect subfile root and build A2'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', false)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'A/main.tex'},
            {src: 'subfile_sub.tex', dst: 'A/sub/s.tex'},
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertBuild({fixture, texName: 'A/sub/s.tex', pdfName: 'A/main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'auto-detect subfile root and build B1'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', true)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'B/main.tex'},
            {src: 'subfile_sub.tex', dst: 'B/sub/s.tex'},
            {src: 'empty', dst: 'A/empty'}
        ])
        await assertBuild({fixture, texName: 'B/sub/s.tex', pdfName: 'B/sub/s.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'auto-detect subfile root and build B2'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', false)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'B/main.tex'},
            {src: 'subfile_sub.tex', dst: 'B/sub/s.tex'},
            {src: 'empty', dst: 'A/empty'}
        ])
        await assertBuild({fixture, texName: 'B/sub/s.tex', pdfName: 'B/main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'auto build with subfiles and onSave 1'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.autoBuild.run', 'onSave')
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', false)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'A/main.tex'},
            {src: 'subfile_sub.tex', dst: 'A/sub/s.tex'},
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertAutoBuild({fixture, texName: 'A/sub/s.tex', pdfName: 'A/main.pdf'}, ['onSave'])
    })

    runTest({suiteName, fixtureName, testName: 'auto build with subfiles and onSave 2'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.autoBuild.run', 'onSave')
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.useSubFile', true)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'A/main.tex'},
            {src: 'subfile_sub.tex', dst: 'A/sub/s.tex'},
            {src: 'empty', dst: 'B/empty'}
        ])
        await assertAutoBuild({fixture, texName: 'A/sub/s.tex', pdfName: 'A/sub/s.pdf'}, ['onSave'])
    })

    runTest({suiteName, fixtureName, testName: 'switching rootFile'}, async () => {
        await loadTestFile(fixture, [{src: 'base.tex', dst: 'A/main.tex'},
                               {src: 'base.tex', dst: 'B/main.tex'}])
        await assertRoot({fixture, openName: 'A/main.tex', rootName: 'A/main.tex'})
        await assertRoot({fixture, openName: 'B/main.tex', rootName: 'B/main.tex'})
        await assertRoot({fixture, openName: 'A/main.tex', rootName: 'A/main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'switching intellisense'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('intellisense.citation.label', 'bibtex key')
        writeTestFile({fixture, fileName: 'A/main.tex'}, '\\documentclass{article}', '\\begin{document}', 'abc\\cite{}', '\\bibliography{A.bib}', '\\end{document}')
        writeTestFile({fixture, fileName: 'B/main.tex'}, '\\documentclass{article}', '\\begin{document}', 'abc\\cite{}', '\\bibliography{B.bib}', '\\end{document}')
        await loadTestFile(fixture, [
            {src: 'base.bib', dst: 'A/A.bib'},
            {src: 'base.bib', dst: 'B/B.bib'}
        ])
        await lw.completer.citation.parseBibFile(path.resolve(fixture, 'A/A.bib'))
        await lw.completer.citation.parseBibFile(path.resolve(fixture, 'B/B.bib'))

        const resultA = await openActive(fixture, 'A/main.tex')

        const uri = vscode.window.activeTextEditor?.document.uri
        assert.ok(uri)
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
        await vscode.workspace.getConfiguration('latex-workshop', workspaceFolder).update('intellisense.citation.label', 'title', vscode.ConfigurationTarget.WorkspaceFolder)

        const itemsA = getIntellisense(resultA.doc, new vscode.Position(2, 9))
        assert.ok(itemsA)
        assert.strictEqual(itemsA.length, 3)
        assert.strictEqual(itemsA[0].label, 'A fake article')
        assert.ok(itemsA[0].filterText)
        assert.ok(itemsA[0].filterText.includes('Journal of CI tests'))
        assert.ok(!itemsA[0].filterText.includes('hintFake'))

        const resultB = await openActive(fixture, 'B/main.tex')
        const cache = lw.cacher.get(path.resolve(fixture, 'B/main.tex'))
        if (cache) {
            cache.bibfiles = [path.resolve(fixture, 'B/B.bib')]
        } else {
            return
        }

        const itemsB = getIntellisense(resultB.doc, new vscode.Position(2, 9))
        assert.ok(itemsB)
        assert.strictEqual(itemsB.length, 3)
        assert.strictEqual(itemsB[0].label, 'art1')
    })
})
