import fs, { promises as fsp } from 'fs'
import { Block } from '@ethersproject/abstract-provider'
import { BigNumber } from 'ethers'
import { remark } from 'remark'
import remarkToc from 'remark-toc'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import rehypeSlug from 'rehype-slug'
import { visit } from 'unist-util-visit'
import { unified } from 'unified'
import { mdToPdf } from 'md-to-pdf'
import { AllCheckResults, ProposalEvent } from '../types'

// --- Markdown helpers ---

export function bullet(text: string, level: number = 0): string {
  return `${' '.repeat(level * 4)}- ${text}`
}

export function bold(text: string): string {
  return `**${text}**`
}

export function codeBlock(text: string): string {
  // Line break, three backticks, line break, the text, line break, three backticks, line break
  return `\n\`\`\`\n${text}\n\`\`\`\n`
}

/**
 * Block quotes a string in markdown
 * @param str string to block quote
 */
export function blockQuote(str: string): string {
  return str
    .split('\n')
    .map((s) => '> ' + s)
    .join('\n')
}

/**
 * Turns a plaintext address into a link to etherscan page of that address
 * @param address to be linked
 * @param code whether to link to the code tab
 */
export function toAddressLink(address: string, code: boolean = false): string {
  return `[\`${address}\`](https://etherscan.io/address/${address}${code ? '#code' : ''})`
}

// -- Report formatters ---

function toMessageList(header: string, text: string[]): string {
  return text.length > 0 ? `${bold(header)}:\n\n` + text.map((msg) => `${msg}`).join('\n') : ''
}

/**
 * Summarize the results of a specific check
 * @param errors the errors returned by the check
 * @param warnings the warnings returned by the check
 * @param name the descriptive name of the check
 */
function toCheckSummary({ result: { errors, warnings, info }, name }: AllCheckResults[string]): string {
  const status = errors.length === 0 ? (warnings.length === 0 ? '✅ Passed' : '⚠️ Passed with warnings') : '❌ Failed'

  return `### ${name} ${status}

${toMessageList('Errors', errors)}

${toMessageList('Warnings', warnings)}

${toMessageList('Info', info)}
`
}

/**
 * Pulls the title out of the markdown description, from the first markdown h1 line
 * @param description the proposal description
 */
function getProposalTitle(description: string) {
  const match = description.match(/^\s*#\s*(.*)\s*\n/)
  if (!match || match.length < 2) return 'Title not found'
  return match[1]
}

/**
 * Format a block timestamp which is always in epoch seconds to a human readable string
 * @param blockTimestamp the block timestamp to format
 */
function formatTime(blockTimestamp: number): string {
  return `${new Date(blockTimestamp * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York',
  })} ET`
}

/**
 * Estimate the timestamp of a future block number
 * @param current the current block
 * @param block the future block number
 */
function estimateTime(current: Block, block: BigNumber): number {
  if (block.lt(current.number)) throw new Error('end block is less than current')
  return block.sub(current.number).mul(13).add(current.timestamp).toNumber()
}

/**
 * Generates the proposal report and saves Markdown, PDF, and HTML versions of it.
 * @param blocks the relevant blocks for the proposal.
 * @param proposal The proposal details.
 * @param checks The checks results.
 * @param dir The directory where the file should be saved. It will be created if it doesn't exist.
 * @param filename The name of the file. All report formats will have the same filename with different extensions.
 */
export async function generateAndSaveReports(
  blocks: { current: Block; start: Block | null; end: Block | null },
  proposal: ProposalEvent,
  checks: AllCheckResults,
  dir: string
) {
  // Prepare the output folder and filename.
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const id = proposal.id
  const path = `${dir}/${id}`

  // Generate the base markdown proposal report. This is the markdown report which is translated into other file types.
  const baseReport = await toMarkdownProposalReport(blocks, proposal, checks)

  // The table of contents' links in the baseReport work when converted to HTML, but do not work as Markdown
  // or PDF links, since the emojis in the header titles cause issues. We apply the remarkFixEmojiLinks plugin
  // to fix this, and use this updated version when generating the Markdown and PDF reports.
  const markdownReport = String(await remark().use(remarkFixEmojiLinks).process(baseReport))

  // Generate the HTML report string using the `baseReport`.
  const htmlReport = String(
    await unified()
      .use(remarkParse)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(rehypeStringify)
      .use(rehypeSlug)
      .process(baseReport)
  )

  // Save off all reports. The Markdown and PDF reports use the `markdownReport`.
  await Promise.all([
    fsp.writeFile(`${path}.html`, htmlReport),
    fsp.writeFile(`${path}.md`, markdownReport),
    mdToPdf({ content: markdownReport }, { dest: `${path}.pdf` }),
  ])
}

/**
 * Produce a markdown report summarizing the result of all the checks for a given proposal.
 * @param blocks the relevant blocks for the proposal.
 * @param proposal The proposal details.
 * @param checks The checks results.
 */
async function toMarkdownProposalReport(
  blocks: { current: Block; start: Block | null; end: Block | null },
  proposal: ProposalEvent,
  checks: AllCheckResults
): Promise<string> {
  const { id, proposer, targets, endBlock, startBlock, description } = proposal

  // Generate the report. We insert an empty table of contents header which is populated later using remark-toc.
  const report = `
# ${getProposalTitle(description.trim())}

_Updated as of block [${blocks.current.number}](https://etherscan.io/block/${blocks.current.number}) at ${formatTime(
    blocks.current.timestamp
  )}_

- ID: ${id}
- Proposer: ${toAddressLink(proposer)}
- Start Block: ${startBlock} (${
    blocks.start ? formatTime(blocks.start.timestamp) : formatTime(estimateTime(blocks.current, startBlock))
  })
- End Block: ${endBlock} (${
    blocks.end ? formatTime(blocks.end.timestamp) : formatTime(estimateTime(blocks.current, endBlock))
  })
- Targets: ${targets.map((target) => toAddressLink(target, true)).join('; ')}

## Table of contents

This is filled in by remark-toc and this sentence will be removed.

## Proposal Text

${blockQuote(description.trim())}

## Checks\n
${Object.keys(checks)
  .map((checkId) => toCheckSummary(checks[checkId]))
  .join('\n')}
`

  // Add table of contents and return report.
  return (await remark().use(remarkToc, { tight: true }).process(report)).toString()
}

/**
 * Intra-doc links are broken if the header has emojis, so we fix that here.
 * @dev This is a remark plugin, see the remark docs for more info on how it works.
 */
function remarkFixEmojiLinks() {
  return (tree: any) => {
    visit(tree, (node) => {
      if (node.type === 'link') {
        // @ts-ignore node.url does exist, the typings just aren't correct
        const url: string = node.url
        const isInternalLink = url.startsWith('#')
        if (isInternalLink && url.endsWith('--passed-with-warnings')) {
          // @ts-ignore node.url does exist, the typings just aren't correct
          node.url = node.url.replace('--passed-with-warnings', '-⚠️-passed-with-warnings')
        } else if (isInternalLink && url.endsWith('--passed')) {
          // @ts-ignore node.url does exist, the typings just aren't correct
          node.url = node.url.replace('--passed', '-✅-passed')
        } else if (isInternalLink && url.endsWith('--failed')) {
          // @ts-ignore node.url does exist, the typings just aren't correct
          node.url = node.url.replace('--failed', '-❌-failed')
        }
      }
    })
  }
}
