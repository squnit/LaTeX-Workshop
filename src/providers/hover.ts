import * as vscode from 'vscode'
import * as lw from '../lw'
import { tokenizer, onAPackage } from './tokenizer'

export class HoverProvider implements vscode.HoverProvider {
    public async provideHover(document: vscode.TextDocument, position: vscode.Position, ctoken: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        lw.mathPreview.getColor()
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        const hov = configuration.get('hover.preview.enabled') as boolean
        const hovReference = configuration.get('hover.ref.enabled') as boolean
        const hovCitation = configuration.get('hover.citation.enabled') as boolean
        const hovCommand = configuration.get('hover.command.enabled') as boolean
        if (hov) {
            const tex = lw.mathPreview.findHoverOnTex(document, position)
            if (tex) {
                const newCommands = await lw.mathPreview.findProjectNewCommand(ctoken)
                const hover = await lw.mathPreview.provideHoverOnTex(document, tex, newCommands)
                return hover
            }
            const graphicsHover = await lw.graphicsPreview.provideHover(document, position)
            if (graphicsHover) {
                return graphicsHover
            }
        }
        const token = tokenizer(document, position)
        if (!token) {
            return undefined
        }
        // Test if we are on a command
        if (token.startsWith('\\')) {
            if (!hovCommand) {
                return undefined
            }
            return this.provideHoverOnCommand(token)
        }
        if (onAPackage(document, position, token)) {
            const pkg = encodeURIComponent(JSON.stringify(token))
            const md = `Package **${token}** \n\n`
            const mdLink = new vscode.MarkdownString(`[View documentation](command:latex-workshop.texdoc?${pkg})`)
            mdLink.isTrusted = true
            const ctanUrl = `https://ctan.org/pkg/${token}`
            const ctanLink = new vscode.MarkdownString(`[${ctanUrl}](${ctanUrl})`)
            return new vscode.Hover([md, mdLink, ctanLink])
        }
        const refData = lw.completer.reference.getRef(token)
        if (hovReference && refData) {
            const hover = await lw.mathPreview.provideHoverOnRef(document, position, refData, token, ctoken)
            return hover
        }
        const cite = lw.completer.citation.getEntryWithDocumentation(token, document.uri)
        if (hovCitation && cite) {
            const range = document.getWordRangeAtPosition(position, /\{.*?\}/)
            const md = cite.documentation || cite.detail
            if (md) {
                return new vscode.Hover(md, range)
            }
        }
        return undefined
    }

    private provideHoverOnCommand(token: string): vscode.Hover | undefined {
        const signatures: string[] = []
        const pkgs: string[] = []
        const tokenWithoutSlash = token.substring(1)

        lw.cacher.getIncludedTeX().forEach(cachedFile => {
            const cachedCmds = lw.cacher.get(cachedFile)?.elements.command
            if (cachedCmds === undefined) {
                return
            }
            cachedCmds.forEach(cmd => {
                const cmdName = cmd.name()
                if (cmdName.startsWith(tokenWithoutSlash) && (cmdName.length === tokenWithoutSlash.length)) {
                    if (typeof cmd.documentation !== 'string') {
                        return
                    }
                    const doc = cmd.documentation
                    const packageName = cmd.package
                    if (packageName && packageName !== 'user-defined' && (!pkgs.includes(packageName))) {
                        pkgs.push(packageName)
                    }
                    signatures.push(doc)
                }
            })
        })

        let pkgLink = ''
        if (pkgs.length > 0) {
            pkgLink = '\n\nView documentation for package(s) '
            pkgs.forEach(p => {
                const pkg = encodeURIComponent(JSON.stringify(p))
                pkgLink += `[${p}](command:latex-workshop.texdoc?${pkg}),`
            })
            pkgLink = pkgLink.substring(0, pkgLink.lastIndexOf(',')) + '.'
        }
        if (signatures.length > 0) {
            const mdLink = new vscode.MarkdownString(signatures.join('  \n')) // We need two spaces to ensure md newline
            mdLink.appendMarkdown(pkgLink)
            mdLink.isTrusted = true
            return new vscode.Hover(mdLink)
        }
        return undefined
    }
}
