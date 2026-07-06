#!/usr/bin/env node
/**
 * Smoke-test for gui_to_prompt.js against the barebone workflow [5].
 *
 * Loads final.json, runs the GUI->prompt conversion, and prints key checks.
 *
 * Usage:
 *   node scripts/test_gui_to_prompt.js [path-to-workflow.json]
 */
const fs = require('fs');
const path = require('path');
const { guiToPrompt } = require('./gui_to_prompt.js');

const SRC = process.argv[2] || path.join(__dirname, '..', 'final.json');
const gui = JSON.parse(fs.readFileSync(SRC, 'utf-8'));

console.log('Source:', SRC);
console.log('Nodes in GUI format:', gui.nodes.length);

const prompt = guiToPrompt(gui);
const promptKeys = Object.keys(prompt);
console.log('Nodes in prompt format:', promptKeys.length);

if (promptKeys.length !== gui.nodes.length) {
  console.error('!! node count mismatch:', promptKeys.length, 'vs', gui.nodes.length);
  process.exit(1);
}

// Spot-check critical inputs for the barebone workflow [5].
const checks = [
  ['1',   'image',            'string', 'body LoadImage -> filename string'],
  ['2',   'image',            'string', 'tattoo LoadImage -> filename string'],
  ['10',  'image',            'array',  'ImageScaleToMaxDimension image linked'],
  ['10',  'largest_size',     'number', 'ImageScaleToMaxDimension largest_size is number'],
  ['22',  'input',            'array',  'ResizeImageMaskNode input is linked'],
  ['22',  'resize_type',       'string', 'ResizeImageMaskNode resize_type is string (DynamicCombo choice)'],
  ['22',  'resize_type.width', 'number', 'ResizeImageMaskNode width sub-field lives at the dotted-path top-level key'],
  ['22',  'scale_method',      'string', 'ResizeImageMaskNode scale_method is string (interpolation)'],
  ['60',  'clip',             'array',  'CLIPTextEncode clip is linked'],
  ['60',  'text',             'string', 'CLIPTextEncode text is string'],
  ['203', 'destination',      'array',  'CompositeMasked destination linked'],
  ['203', 'source',           'array',  'CompositeMasked source linked'],
  ['203', 'mask',             'array',  'CompositeMasked mask linked'],
  ['203', 'x',                'number', 'CompositeMasked x is number'],
  ['203', 'y',                'number', 'CompositeMasked y is number'],
  ['218', 'image',            'array',  'RotateImage image is linked'],
  ['218', 'angle',            'number', 'RotateImage angle is integer (free 0-359)'],
  ['218', 'counter_clockwise','boolean','RotateImage counter_clockwise is boolean'],
];

let failures = 0;
for (const [nid, name, expectedType, desc] of checks) {
  const entry = prompt[nid];
  if (!entry) {
    console.error('!! missing node', nid);
    failures++;
    continue;
  }
  const value = entry.inputs[name];
  let actualType;
  if (Array.isArray(value)) actualType = 'array';
  else if (typeof value === 'number') actualType = 'number';
  else if (typeof value === 'string') actualType = 'string';
  else if (typeof value === 'boolean') actualType = 'boolean';
  else actualType = typeof value;
  const ok = actualType === expectedType;
  const sym = ok ? '\u2713' : '\u2717';
  console.log('  ' + sym + ' node ' + nid + ' inputs.' + name + ' = ' + JSON.stringify(value) + '  (' + desc + ')');
  if (!ok) failures++;
}

// Link integrity
const nodeIds = new Set(promptKeys);
let broken = 0;
let totalLinks = 0;
for (const nid of promptKeys) {
  for (const value of Object.values(prompt[nid].inputs)) {
    if (Array.isArray(value) && value.length === 2) {
      totalLinks++;
      if (!nodeIds.has(value[0])) {
        console.error('  !! node ' + nid + ' has broken link -> ' + value[0]);
        broken++;
      }
    }
  }
}
console.log('  \u2713 ' + totalLinks + ' link references, ' + broken + ' broken');

if (failures > 0 || broken > 0) {
  console.error('\n' + (failures + broken) + ' check(s) FAILED');
  process.exit(1);
}
console.log('\n\u2713 All smoke checks passed.');
