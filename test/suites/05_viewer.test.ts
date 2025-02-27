import * as vscode from 'vscode'
import * as path from 'path'
import rimraf from 'rimraf'
import * as lw from '../../src/lw'
import { sleep, assertBuild, assertViewer, runTest, waitBuild, loadTestFile } from './utils'

suite('PDF viewer test suite', () => {

    const suiteName = path.basename(__filename).replace('.test.js', '')
    let fixture = path.resolve(__dirname, '../../../test/fixtures/testground')
    const fixtureName = 'testground'

    suiteSetup(() => {
        fixture = path.resolve(lw.extensionRoot, 'test/fixtures/testground')
    })

    setup(async () => {
        await vscode.commands.executeCommand('latex-workshop.activate')
        await vscode.workspace.getConfiguration().update('latex-workshop.view.pdf.viewer', 'tab')
    })

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        lw.manager.rootFile = undefined

        await vscode.workspace.getConfiguration().update('latex-workshop.latex.outDir', undefined)
        await vscode.workspace.getConfiguration().update('latex-workshop.view.pdf.viewer', undefined)
        await vscode.workspace.getConfiguration().update('latex-workshop.latex.rootFile.useSubFile', undefined)
        await vscode.workspace.getConfiguration().update('latex-workshop.latex.rootFile.doNotPrompt', undefined)
        await vscode.workspace.getConfiguration().update('latex-workshop.synctex.afterBuild.enabled', undefined)

        if (path.basename(fixture) === 'testground') {
            rimraf(fixture + '/{*,.vscode/*}', (e) => {if (e) {console.error(e)}})
            await sleep(500) // Required for pooling
        }
    })

    runTest({suiteName, fixtureName, testName: 'basic build and view'}, async () => {
        await loadTestFile(fixture, [{src: 'base.tex', dst: 'main.tex'}])
        await assertBuild({fixture, texName: 'main.tex', pdfName: 'main.pdf'})
        await assertViewer({fixture, pdfName: 'main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'build main.tex and view it'}, async () => {
        await vscode.workspace.getConfiguration().update('latex-workshop.latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration().update('latex-workshop.latex.rootFile.useSubFile', false)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'main.tex'},
            {src: 'subfile_sub.tex', dst: 'sub/s.tex'}
        ])
        await assertBuild({fixture, texName: 'sub/s.tex', pdfName: 'main.pdf'})
        await assertViewer({fixture, pdfName: 'main.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'build a subfile and view it'}, async () => {
        await vscode.workspace.getConfiguration().update('latex-workshop.latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration().update('latex-workshop.latex.rootFile.useSubFile', true)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'main.tex'},
            {src: 'subfile_sub.tex', dst: 'sub/s.tex'}
        ])
        await assertBuild({fixture, texName: 'sub/s.tex', pdfName: 'sub/s.pdf'})
        await assertViewer({fixture, pdfName: 'sub/s.pdf'})
    })

    runTest({suiteName, fixtureName, testName: 'build main.tex with QuickPick and view it'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', false)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'main.tex'},
            {src: 'subfile_sub.tex', dst: 'sub/s.tex'}
        ])
        await assertBuild({fixture, texName: 'sub/s.tex', pdfName: 'main.pdf', build: async () => {
            const wait = waitBuild()
            void vscode.commands.executeCommand('latex-workshop.build')
            await sleep(1000)
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem')
            await wait
        }})
        await assertViewer({fixture, pdfName: 'main.pdf', action: async () => {
            await sleep(1000)
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem')
        }})
    })

    runTest({suiteName, fixtureName, testName: 'build s.tex with QuickPick and view it'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', false)
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'main.tex'},
            {src: 'subfile_sub.tex', dst: 'sub/s.tex'}
        ])
        await assertBuild({fixture, texName: 'sub/s.tex', pdfName: 'sub/s.pdf', build: async () => {
            const wait = waitBuild()
            void vscode.commands.executeCommand('latex-workshop.build')
            await sleep(1000)
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext')
            await sleep(500)
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem')
            await wait
        }})
        await assertViewer({fixture, pdfName: 'sub/s.pdf', action: async () => {
            await sleep(1000)
            await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext')
            await sleep(500)
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem')
        }})
    })

    runTest({suiteName, fixtureName, testName: 'build with outDir and view it'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.outDir', './out')
        await loadTestFile(fixture, [{src: 'base.tex', dst: 'main.tex'}])
        await assertBuild({fixture, texName: 'main.tex', pdfName: 'out/main.pdf'})
        await assertViewer({fixture, pdfName: 'out/main.pdf'})
    })
})
