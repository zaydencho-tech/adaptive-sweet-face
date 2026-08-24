import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import resourceInliner from "web-resource-inliner";

const ASSET_EXTENSION = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf)$/i;
const LOCAL_ASSET_REFERENCE =
  /(["'`])((?:(?:\.{1,2}\/)|\/)?[A-Za-z0-9_@%+\-./]+?\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf)(?:[?#][^"'`\s<>()]*)?)\1/g;
const CARD_NEWS_TOPICS = Object.freeze({
  frailty: 10,
  muscle: 14,
  exercise: 20,
  nutrition: 14,
  cognition: 10,
  mental: 11,
});

const MIME_TYPES = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function inlineHtml(options) {
  return new Promise((resolve, reject) => {
    resourceInliner.html(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function inlineCss(options) {
  return new Promise((resolve, reject) => {
    resourceInliner.css(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function escapeForScript(value) {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function fileToDataUri(filePath, contents) {
  const extension = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[extension];
  if (!mime) {
    throw new Error(`Unsupported standalone asset type: ${filePath}`);
  }
  return `data:${mime};base64,${contents.toString("base64")}`;
}

function removeQueryAndHash(value) {
  const queryOrHashIndex = value.search(/[?#]/);
  return queryOrHashIndex === -1 ? value : value.slice(0, queryOrHashIndex);
}

function isInsideDirectory(filePath, directory) {
  const relativePath = path.relative(directory, filePath);
  return (
    relativePath &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  );
}

function protectInlineScripts(html) {
  const scripts = [];
  const protectedHtml = html.replace(
    /<script\b(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi,
    (wholeTag, attributes, contents) => {
      const token = `__BUVI_STANDALONE_INLINE_SCRIPT_${scripts.length}__`;
      // Keep the surrounding tag in place. Replacing the token with a full
      // <script> element would create a nested script tag after the resource
      // inliner runs, which makes the resulting document invalid JavaScript.
      scripts.push({ token, replacement: contents });
      return `<script${attributes}>${token}</script>`;
    },
  );
  return { html: protectedHtml, scripts };
}

function restoreInlineScripts(html, scripts) {
  return scripts.reduce((result, script) => result.replace(script.token, script.replacement), html);
}

function removeRemoteConnectionHints(html) {
  return html.replace(/<link\b(?=[^>]*\brel=["'](?:preconnect|dns-prefetch)["'])[^>]*>/gi, "");
}

async function inlineInlineStyleUrls(html, publicDirectory) {
  const stylePattern = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  const matches = Array.from(html.matchAll(stylePattern));
  if (!matches.length) return html;

  let output = "";
  let lastIndex = 0;
  for (const match of matches) {
    const [wholeTag, attributes, stylesheet] = match;
    const startIndex = match.index ?? 0;
    output += html.slice(lastIndex, startIndex);
    const inlinedStylesheet = await inlineCss({
      fileContent: stylesheet,
      relativeTo: publicDirectory,
      images: true,
      strict: true,
    });
    output += `<style${attributes}>${inlinedStylesheet}</style>`;
    lastIndex = startIndex + wholeTag.length;
  }
  output += html.slice(lastIndex);
  return output;
}

class LocalAssetRegistry {
  constructor(publicDirectory) {
    this.publicDirectory = publicDirectory;
    this.cache = new Map();
  }

  async resolve(reference) {
    if (!reference || /^(?:data:|blob:|https?:|\/\/|#)/i.test(reference)) {
      return null;
    }

    const sourcePath = removeQueryAndHash(reference).replace(/^\/+/, "");
    if (!ASSET_EXTENSION.test(sourcePath)) return null;

    const absolutePath = path.resolve(this.publicDirectory, sourcePath);
    if (!isInsideDirectory(absolutePath, this.publicDirectory)) return null;

    try {
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) return null;
    } catch {
      return null;
    }

    if (!this.cache.has(absolutePath)) {
      this.cache.set(
        absolutePath,
        readFile(absolutePath).then((contents) => fileToDataUri(absolutePath, contents)),
      );
    }
    return this.cache.get(absolutePath);
  }

  async cardNewsManifest() {
    const manifest = {};
    for (const [topic, pageCount] of Object.entries(CARD_NEWS_TOPICS)) {
      manifest[topic] = await Promise.all(
        Array.from({ length: pageCount }, async (_, index) => {
          const fileName = `page-${String(index + 1).padStart(2, "0")}.avif`;
          const reference = `./assets/card-news/0728/${topic}/${fileName}`;
          const dataUri = await this.resolve(reference);
          if (!dataUri) {
            throw new Error(`Missing card-news page required for standalone build: ${reference}`);
          }
          return dataUri;
        }),
      );
    }
    return manifest;
  }
}

async function inlineLocalAssetReferences(html, registry) {
  const matches = Array.from(html.matchAll(LOCAL_ASSET_REFERENCE));
  if (!matches.length) return html;

  let output = "";
  let lastIndex = 0;
  for (const match of matches) {
    const [wholeReference, quote, source] = match;
    const startIndex = match.index ?? 0;
    output += html.slice(lastIndex, startIndex);
    const dataUri = await registry.resolve(source);
    output += dataUri ? `${quote}${dataUri}${quote}` : wholeReference;
    lastIndex = startIndex + wholeReference.length;
  }
  output += html.slice(lastIndex);
  return output;
}

function preserveInlinedAssetSemantics(html) {
  // The source distinguishes owl SVGs from raster scene assets by their file
  // name. After inlining, that file name is a data URI, so retain the same
  // object-contain treatment for embedded owl SVGs.
  return html
    .replaceAll(
      "source.includes('./owl-')",
      "source.includes('./owl-') || source.startsWith('data:image/svg+xml')",
    )
    .replaceAll(
      "slide.image?.includes('./owl-')",
      "slide.image?.includes('./owl-') || slide.image?.startsWith('data:image/svg+xml')",
    );
}

async function injectCardNewsManifest(html, registry) {
  const manifest = await registry.cardNewsManifest();
  const serializedManifest = escapeForScript(JSON.stringify(manifest));
  // Keep the sizable card-news payload as data, rather than executable JavaScript.
  // iOS Safari can fail while compiling a multi-megabyte JavaScript object literal
  // from a locally opened HTML file. JSON script blocks are not compiled by the JS
  // engine and are parsed only once when the card-news catalogue is initialized.
  const manifestTag = `<script id="buvi-standalone-card-news" type="application/json">${serializedManifest}</script>`;

  if (!html.includes("</head>")) {
    throw new Error("Standalone build could not find </head> for the card-news manifest.");
  }
  const withManifest = html.replace("</head>", `${manifestTag}</head>`);

  const factoryPattern = /const createPdfCardNewsPages =[\s\S]*?;(?=\s*const PDF_CARD_NEWS)/;
  const replacement = `let buviStandaloneCardNewsManifest;
        const getStandaloneCardNewsManifest = () => {
            if (buviStandaloneCardNewsManifest) return buviStandaloneCardNewsManifest;
            const manifestElement = document.getElementById('buvi-standalone-card-news');
            try {
                buviStandaloneCardNewsManifest = JSON.parse((manifestElement && manifestElement.textContent) || '{}');
            } catch (error) {
                console.error('Standalone card-news data could not be read.', error);
                buviStandaloneCardNewsManifest = {};
            }
            // The parsed object remains in use, so the source text is no longer
            // needed. Removing it gives mobile Safari a chance to reclaim memory.
            if (manifestElement) manifestElement.remove();
            return buviStandaloneCardNewsManifest;
        };
        const createPdfCardNewsPages = (topic, pageCount) => {
            const pages = getStandaloneCardNewsManifest()[topic];
            if (!pages || pages.length < pageCount) {
                throw new Error(\`Standalone card-news asset is missing for \${topic}.\`);
            }
            return pages.slice(0, pageCount);
        };`;

  if (!factoryPattern.test(withManifest)) {
    throw new Error("Standalone build could not replace createPdfCardNewsPages().");
  }
  return withManifest.replace(factoryPattern, replacement);
}

async function transpileInlineScriptsForSafari(html) {
  const scriptPattern = /<script\b(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  const matches = Array.from(html.matchAll(scriptPattern));
  if (!matches.length) return html;

  let output = "";
  let lastIndex = 0;
  for (const match of matches) {
    const [wholeTag, attributes, contents] = match;
    const startIndex = match.index ?? 0;
    output += html.slice(lastIndex, startIndex);

    // Data blocks deliberately remain untouched. They are consumed at runtime
    // and must not be interpreted as JavaScript by the build step.
    if (/\btype\s*=\s*["']application\/json["']/i.test(attributes) || !contents.trim()) {
      output += wholeTag;
    } else {
      const transformed = await transform(contents, {
        loader: "js",
        // Card-news images use AVIF, which is supported from iOS Safari 16.1.
        // Target the same practical baseline and avoid unsupported legacy
        // transforms in newer esbuild releases used by GitHub Actions.
        target: "safari16",
        minify: false,
        legalComments: "inline",
      });
      // A literal closing script sequence inside an emitted template string
      // would terminate the HTML script element before Safari can evaluate it.
      const safeCode = transformed.code.replace(/<\/script/gi, "<\\/script");
      output += `<script${attributes}>${safeCode}</script>`;
    }
    lastIndex = startIndex + wholeTag.length;
  }
  output += html.slice(lastIndex);
  return output;
}

function validateStandaloneDocument(html) {
  const remoteExecutableResource = /<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i;
  const remoteExecutableMatch = html.match(remoteExecutableResource);
  if (remoteExecutableMatch) {
    throw new Error(
      `Standalone build still contains an external script or stylesheet URL: ${remoteExecutableMatch[0]}`,
    );
  }

  const remoteStyleResource = /<style\b[^>]*>[\s\S]*?url\(\s*["']?https?:\/\//i;
  const remoteStyleMatch = html.match(remoteStyleResource);
  if (remoteStyleMatch) {
    throw new Error(
      `Standalone build still contains an external CSS resource URL: ${remoteStyleMatch[0].slice(-200)}`,
    );
  }

  if (!html.includes('id="buvi-standalone-card-news"')) {
    throw new Error("Standalone build is missing the embedded card-news manifest.");
  }

  for (const [topic, pageCount] of Object.entries(CARD_NEWS_TOPICS)) {
    const pagePattern = new RegExp(`"${topic}":\\[`, "g");
    if (!pagePattern.test(html)) {
      throw new Error(`Standalone build is missing the ${topic} card-news collection.`);
    }
    const expectedMarker = `pageCount) => {`;
    if (!html.includes(expectedMarker)) {
      throw new Error(`Standalone build could not validate ${pageCount} ${topic} card-news pages.`);
    }
  }
}

/**
 * Extends vite-plugin-singlefile for BUVI's standalone public HTML source.
 *
 * vite-plugin-singlefile handles Vite chunks. This plugin inlines remaining
 * CDN resources, CSS font URLs, runtime image strings, and dynamically
 * generated card-news pages before removing every sibling output file.
 */
export function buviStandalonePlugin({ publicDirectory }) {
  return {
    name: "buvi-standalone-assets",
    apply: "build",
    enforce: "post",
    async generateBundle(_outputOptions, bundle) {
      const htmlEntries = Object.values(bundle).filter(
        (entry) => entry.type === "asset" && entry.fileName.endsWith(".html"),
      );

      if (htmlEntries.length !== 1) {
        throw new Error(
          `BUVI standalone build expects one HTML output, received ${htmlEntries.length}.`,
        );
      }

      const htmlEntry = htmlEntries[0];
      const registry = new LocalAssetRegistry(publicDirectory);
      const originalHtml = String(htmlEntry.source);
      const protectedScripts = protectInlineScripts(removeRemoteConnectionHints(originalHtml));

      const externallyInlined = await inlineHtml({
        fileContent: protectedScripts.html,
        relativeTo: publicDirectory,
        images: true,
        svgs: true,
        scripts: true,
        links: true,
        strict: false,
      });
      const restoredScripts = restoreInlineScripts(externallyInlined, protectedScripts.scripts);
      const stylesInlined = await inlineInlineStyleUrls(restoredScripts, publicDirectory);
      const localAssetsInlined = preserveInlinedAssetSemantics(
        await inlineLocalAssetReferences(stylesInlined, registry),
      );
      const safariCompatibleHtml = await transpileInlineScriptsForSafari(localAssetsInlined);
      const standaloneHtml = await injectCardNewsManifest(safariCompatibleHtml, registry);

      validateStandaloneDocument(standaloneHtml);
      htmlEntry.source = standaloneHtml;

      for (const [fileName, entry] of Object.entries(bundle)) {
        if (entry !== htmlEntry) delete bundle[fileName];
      }

      const cardNewsPageCount = Object.values(CARD_NEWS_TOPICS).reduce(
        (total, count) => total + count,
        0,
      );
      this.info(
        `[buvi-standalone] embedded local assets, external fonts/icons, and ${cardNewsPageCount} card-news pages.`,
      );
    },
  };
}
