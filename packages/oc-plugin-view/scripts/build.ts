import { build } from "bun"

const root = `${import.meta.dir}/..`

await build({
  entrypoints: [`${root}/src/index.ts`, `${root}/src/tui.tsx`],
  outdir: `${root}/dist`,
  naming: "[name].[ext]",
  format: "esm",
  target: "bun",
  minify: false,
  external: ["@opentui/*", "solid-js", "solid-js/store", "@opencode/*"],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
})

// The host compiles its own Solid into the binary. A second `solid-js` module
// instance in the bundle means control-flow components read host-owned stores
// through foreign tracking, so the host render never re-runs (dead header click).
const bundled = await Bun.file(`${root}/dist/tui.js`).text()
const foreign = bundled.match(/(?:from|require\()\s*["']solid-js(?:\/store)?["']/)
if (foreign) {
  console.error(
    `build: dist/tui.js imports a second Solid instance (${foreign[0]}); use plain JSX expressions instead of Solid control-flow components`,
  )
  process.exit(1)
}
