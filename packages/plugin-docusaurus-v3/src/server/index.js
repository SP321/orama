import { readFileSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { gzip as gzipCB } from 'node:zlib'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { presets } from '@orama/searchbox'
import { create, insertMultiple, save } from '@orama/orama'
import { JSDOM } from 'jsdom'
import MarkdownIt from 'markdown-it'
import matter from 'gray-matter'

export default function OramaPluginDocusaurus(ctx, options) {
  let versions = []

  return {
    name: '@orama/plugin-docusaurus-v3',

    getPathsToWatch() {
      return [getThemePath()]
    },

    getThemePath() {
      return getThemePath()
    },

    getClientModules() {
      return [resolve(getThemePath(), 'SearchBar/index.css')]
    },

    async contentLoaded({ actions, allContent }) {
      const isDevelopment = process.env.NODE_ENV === 'development'

      const loadedVersions = allContent['docusaurus-plugin-content-docs']?.default?.loadedVersions
      versions = loadedVersions.map((v) => v.versionName)

      await Promise.all(
        versions.map((version) => buildDevSearchData(ctx.siteDir, ctx.generatedFilesDir, allContent, version))
      )

      if (isDevelopment) {
        actions.setGlobalData({
          searchData: Object.fromEntries(
            await Promise.all(
              versions.map(async (version) => {
                return [version, readFileSync(indexPath(ctx.generatedFilesDir, version))]
              })
            )
          )
        })
      } else {
        actions.setGlobalData({ searchData: {} })
      }
    },

    async postBuild({ outDir }) {
      await Promise.all(
        versions.map(async (version) => {
          return cp(indexPath(ctx.generatedFilesDir, version), indexPath(outDir, version))
        })
      )
    }
  }
}

async function buildDevSearchData(siteDir, generatedFilesDir, allContent, version) {
  const loadedVersion = allContent['docusaurus-plugin-content-docs']?.default?.loadedVersions?.find(
    (v) => v.versionName === version
  )
  const blogs = allContent['docusaurus-plugin-content-blog']?.default?.blogPosts?.map(({ metadata }) => metadata) ?? []
  const pages = allContent['docusaurus-plugin-content-pages']?.default ?? []
  const docs = loadedVersion?.docs ?? []

  const oramaDocs = [
    ...(await Promise.all(blogs.map((data) => generateDocs(siteDir, data, version)))),
    ...(await Promise.all(pages.map((data) => generateDocs(siteDir, data, version)))),
    ...(await Promise.all(docs.map((data) => generateDocs(siteDir, data, version))))
  ]
    .flat()
    .map((data) => ({
      title: data.title,
      content: data.content,
      section: data.originalTitle,
      path: data.path,
      category: ''
    }))

  const db = await create({
    schema: presets.docs.schema
  })

  await insertMultiple(db, oramaDocs)

  const serializedOrama = JSON.stringify(await save(db))
  const gzipedOrama = await gzip(serializedOrama)

  writeFileSync(indexPath(generatedFilesDir, version), gzipedOrama)
}

async function generateDocs(siteDir, content, version) {
  const { title, permalink, source } = content

  const fileContent = readFileSync(source.replace('@site', siteDir), 'utf-8')
  const contentWithoutFrontMatter = matter(fileContent).content

  return parseHTMLContent({
    originalTitle: title,
    html: new MarkdownIt().render(contentWithoutFrontMatter),
    path: permalink
  })
}

function parseHTMLContent({ html, path, originalTitle }) {
  const dom = new JSDOM(html)
  const document = dom.window.document

  const sections = []

  const headers = document.querySelectorAll('h1, h2, h3, h4, h5, h6')
  headers.forEach((header) => {
    const sectionTitle = header.textContent.trim()
    const headerTag = header.tagName.toLowerCase()
    let sectionContent = ''

    let sibling = header.nextElementSibling
    while (sibling && !['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(sibling.tagName)) {
      sectionContent += sibling.textContent.trim() + '\n'
      sibling = sibling.nextElementSibling
    }

    sections.push({
      originalTitle,
      title: sectionTitle,
      header: headerTag,
      content: sectionContent,
      path
    })
  })

  return sections
}

function indexPath(outDir, version) {
  return resolve(outDir, 'orama-search-index-@VERSION@.json.gz'.replace('@VERSION@', version))
}

const gzip = promisify(gzipCB)

function getThemePath() {
  return new URL('../client/theme', import.meta.url).pathname
}
