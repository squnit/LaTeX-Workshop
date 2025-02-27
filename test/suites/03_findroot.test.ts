import * as vscode from 'vscode'
import * as path from 'path'
import rimraf from 'rimraf'
import * as assert from 'assert'
import * as lw from '../../src/lw'
import { sleep, assertRoot, runTest, loadTestFile } from './utils'

suite('Find root file test suite', () => {

    const suiteName = path.basename(__filename).replace('.test.js', '')
    let fixture = path.resolve(__dirname, '../../../test/fixtures/testground')
    const fixtureName = 'testground'

    suiteSetup(() => {
        fixture = path.resolve(lw.extensionRoot, 'test/fixtures/testground')
    })

    setup(async () => {
        await vscode.commands.executeCommand('latex-workshop.activate')
    })

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        lw.manager.rootFile = undefined

        if (path.basename(fixture) === 'testground') {
            rimraf(fixture + '/{*,.vscode/*}', (e) => {if (e) {console.error(e)}})
            await sleep(500) // Required for pooling
        }
    })


    runTest({suiteName, fixtureName, testName: 'detect root with search.rootFiles.include'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.search.rootFiles.include', ['alt/*.tex'])
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'main.tex'},
            {src: 'input_parentsub.tex', dst: 'alt/main.tex'},
            {src: 'plain.tex', dst: 'sub/s.tex'}
        ])
        await assertRoot({fixture, openName: 'sub/s.tex', rootName: 'alt/main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'detect root with search.rootFiles.exclude'}, async () => {
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.rootFile.doNotPrompt', true)
        await vscode.workspace.getConfiguration('latex-workshop').update('latex.search.rootFiles.exclude', ['*.tex'])
        await loadTestFile(fixture, [
            {src: 'subfile_base.tex', dst: 'main.tex'},
            {src: 'input_parentsub.tex', dst: 'alt/main.tex'},
            {src: 'plain.tex', dst: 'sub/s.tex'}
        ])
        await assertRoot({fixture, openName: 'sub/s.tex', rootName: 'alt/main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'auto-detect root with verbatim'}, async () => {
        await loadTestFile(fixture, [
            {src: 'input_base.tex', dst: 'main.tex'},
            {src: 'plain_verbatim.tex', dst: 'sub/s.tex'}
        ])
        await assertRoot({fixture, openName: 'sub/s.tex', rootName: 'main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'import package'}, async () => {
        await loadTestFile(fixture, [
            {src: 'import_base.tex', dst: 'main.tex'},
            {src: 'import_sub.tex', dst: 'sub/s.tex'},
            {src: 'plain.tex', dst: 'sub/subsub/sss/sss.tex'}
        ])
        await assertRoot({fixture, openName: 'sub/subsub/sss/sss.tex', rootName: 'main.tex'})
    })

    runTest({suiteName, fixtureName, testName: 'circular inclusion'}, async () => {
        await loadTestFile(fixture, [
            {src: 'include_base.tex', dst: 'main.tex'},
            {src: 'include_sub.tex', dst: 'alt.tex'},
            {src: 'plain.tex', dst: 'sub/s.tex'}
        ])
        await assertRoot({fixture, openName: 'alt.tex', rootName: 'main.tex'})
        const includedTeX = lw.cacher.getIncludedTeX()
        assert.ok(includedTeX)
        assert.ok(includedTeX.includes(path.resolve(fixture, 'main.tex')))
        assert.ok(includedTeX.includes(path.resolve(fixture, 'alt.tex')))
        assert.ok(includedTeX.includes(path.resolve(fixture, 'sub/s.tex')))
    })
})
