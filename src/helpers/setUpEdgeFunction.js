const { Buffer } = require('node:buffer')
const { existsSync, readdirSync } = require('node:fs')
const { writeFile, mkdir, readFile } = require('node:fs/promises')
const { join, relative, sep, posix } = require('node:path')

const { readJson } = require('fs-extra')

const packageJson = require('../../package.json')

/**
 * Recursively lists all files in a directory.
 */
const getAllFilesIn = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    if (dirent.isDirectory()) {
      return getAllFilesIn(join(dir, dirent.name)).map((path) => join(dirent.name, path))
    }
    return [join(dir, dirent.name)]
  })

const toPosix = (path) => path.split(sep).join(posix.sep)

const setUpEdgeFunction = async ({ angularJson, projectName, netlifyConfig, constants, failBuild }) => {
  const project = angularJson.projects[projectName]
  const {
    architect: { build },
  } = project
  const outputDir = build?.options?.outputPath
  if (!outputDir || !existsSync(outputDir)) {
    return failBuild('Could not find build output directory')
  }

  netlifyConfig.build.publish = join(outputDir, 'browser')

  const serverDistRoot = join(outputDir, 'server')
  if (!existsSync(serverDistRoot)) {
    console.log('No server output generated, skipping SSR setup.')
    return
  }

  console.log(`Writing Angular SSR Edge Function for project "${projectName}" ...`)

  const edgeFunctionDir = join(constants.INTERNAL_EDGE_FUNCTIONS_SRC, 'angular-ssr')
  await mkdir(edgeFunctionDir, { recursive: true })

  const html = await readFile(join(serverDistRoot, 'index.server.html'), 'utf-8')
  const staticFiles = getAllFilesIn(join(outputDir, 'browser')).map(
    (path) => `/${relative(join(outputDir, 'browser'), path)}`,
  )

  const { routes: prerenderedRoutes } = await readJson(join(outputDir, 'prerendered-routes.json'))
  const excludedPaths = [...staticFiles, ...prerenderedRoutes]

  // buy putting this into a separate module that's imported first,
  // we ensure this is initialised before any other module
  const polyfills = `
  import process from "node:process"

  globalThis.process = process
  globalThis.global = globalThis
  globalThis.DenoEvent = globalThis.Event // storing this for fixup-event.mjs
  `

  // angular's polyfills override the global `Event` with a custom implementation.
  // Deno local doesn't like that and will throw in local dev while dispatching `new Event("load")`.
  // So we reverse angular's override, and go back to Deno's implementation.
  const fixupEvent = `
  globalThis.Event = globalThis.DenoEvent
  `

  const ssrFunction = `
  import "./polyfill.mjs";
  import { Buffer } from "node:buffer";
  import { renderApplication } from "${toPosix(relative(edgeFunctionDir, serverDistRoot))}/render-utils.server.mjs";
  import bootstrap from "${toPosix(relative(edgeFunctionDir, serverDistRoot))}/main.server.mjs";
  import "./fixup-event.mjs";

  const document = Buffer.from(${JSON.stringify(
    Buffer.from(html, 'utf-8').toString('base64'),
  )}, 'base64').toString("utf-8");
  
  export default async (request, context) => {
    const html = await renderApplication(bootstrap, {
      url: request.url,
      document,
      platformProviders: [{ provide: "netlify.request", useValue: request }, { provide: "netlify.context", useValue: context }],
    });
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  
  export const config = {
    path: "/*",
    excludedPath: ${JSON.stringify(excludedPaths)},
    generator: "${packageJson.name}@${packageJson.version}",
    name: "Angular SSR",
  };
  `

  await writeFile(join(edgeFunctionDir, 'polyfill.mjs'), polyfills)
  await writeFile(join(edgeFunctionDir, 'fixup-event.mjs'), fixupEvent)
  await writeFile(join(edgeFunctionDir, 'angular-ssr.mjs'), ssrFunction)
}

module.exports = setUpEdgeFunction