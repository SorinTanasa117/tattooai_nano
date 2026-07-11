#!/usr/bin/env node
'use strict';

/**
 * Regenerates templates/manifest.json by listing every image file that
 * actually exists in the templates/ folder.
 *
 * Netlify serves /templates/* as plain static files -- there's no
 * built-in directory listing at runtime, so the frontend needs a small
 * JSON index to know what's in there. Run this locally whenever you
 * add, remove, or rename a template image, then commit the updated
 * manifest.json alongside your changes:
 *
 *   node scripts/generate-templates-manifest.js
 *
 * This never runs in the browser or in a Netlify Function -- it's a
 * one-off local/CI step, same category as a lint or format script.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
const MANIFEST_PATH = path.join(TEMPLATES_DIR, 'manifest.json');

if (!fs.existsSync(TEMPLATES_DIR)) {
  console.error('No templates/ folder found at ' + TEMPLATES_DIR);
  process.exit(1);
}

const files = fs
  .readdirSync(TEMPLATES_DIR)
  .filter((f) => IMAGE_EXT.test(f) && f.toLowerCase() !== 'manifest.json')
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(files, null, 2) + '\n');

console.log('Wrote ' + path.relative(process.cwd(), MANIFEST_PATH) + ' with ' + files.length + ' template(s):');
files.forEach((f) => console.log('  - ' + f));
