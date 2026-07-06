// Convert a ComfyUI workflow from GUI/API format (the format saved by the
// ComfyUI editor and produced by `final.json`) into the **prompt** format
// expected by POST /prompt.
//
// GUI format (what we have) [1]:
//   { id: 1, type: "LoadImage", widgets_values: ["arm.jpg", "image"],
//     inputs: [{ name: "image", type: "IMAGE", link: 1 }], ... }
//   { id: 2, type: "ImageRotate", widgets_values: ["90 degrees"],
//     inputs: [{ name: "image", link: 14 }], ... }
//
// Prompt format (what /prompt wants):
//   { "1":   { class_type: "LoadImage",     inputs: { image: "arm.jpg" } },
//     "2":   { class_type: "ImageRotate",   inputs: { image: ["21", 0],
//                                                    rotation: "90 degrees" } } }
//
// Each entry in inputs[] either:
//   * carries `link: <int>`     -> value is [src_node_id_string, src_slot_int]
//   * carries `widget: {name}`  -> value is taken from widgets_values[] positionally
//   * carries neither (rare)    -> omitted from prompt inputs (uses default)
//
// Most nodes in `final.json` lack `widget` refs on inputs, so we use a
// per-node-type positional widget-name lookup. Unknown types fall back to
// `["arg_0", "arg_1", ...]`.
//
// References:
//   - ComfyUI prompt format spec:
//       https://github.com/comfyanonymous/ComfyUI/blob/master/server.py
//   - Source workflow shape:
//       /mnt/tattooapp/final.json [1]

// ---------------------------------------------------------------------------
// Per-node-type widget-name tables.
// Each entry is an array of input names, in the same order as widgets_values[].
// Add to this map whenever you introduce a new node type that has widgets.
// ---------------------------------------------------------------------------
const WIDGET_NAMES = {
  // Built-in (comfy-core)
  LoadImage:                  ['image'],
  LoadImageMask:              ['image', 'channel'],
  ImageScaleToMaxDimension:   ['upscale_method', 'largest_size'],
  ImageRotate:                ['rotation'],
  // RotateImage — free-rotation integer (0-359).
  // The input name is 'rotation' in the version used by this workflow
  // (confirmed by ComfyUI node-validation errors when 'angle' was used).
  RotateImage:                ['rotation'],
  // ResizeImageMaskNode (comfy-core v3 schema) -- the v3 node has two
  // distinct widget inputs:
  //   widgets[0] = resize_type choice (e.g. "scale width")
  //   widgets[1] = matching sub-field (width for SCALE_WIDTH)
  //   widgets[2] = scale_method (interpolation, e.g. "lanczos")
  // ComfyUI's DynamicCombo handler reads `resize_type` as a string to pick
  // which sub-fields are required, then `build_nested_inputs` re-nests the
  // sub-fields under the resize_type key before calling execute(). So we
  // emit them as three top-level keys. If the workflow ever switches to a
  // different resize mode (e.g. SCALE_DIMENSIONS) extend this list -- the
  // build_template.py slot mapping assumes SCALE_WIDTH only.
  ResizeImageMaskNode:        ['resize_type', 'resize_type.width', 'scale_method'],
  GetImageSize:               [],
  UnetLoaderGGUF:             ['unet_name'],
  UnetLoader:                 ['unet_name'],
  CLIPLoaderGGUF:             ['clip_name', 'type'],
  CLIPLoader:                 ['clip_name', 'type'],
  VAELoader:                  ['vae_name'],
  VAEEncodeTiled:             ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap'],
  VAEDecodeTiled:             ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap'],
  VAEEncode:                  [],
  VAEDecode:                  [],
  CLIPTextEncode:             ['text'],
  ReferenceLatent:            [],
  CFGGuider:                  ['cfg'],
  KSamplerSelect:             ['sampler_name'],
  KSampler:                   [],
  RandomNoise:                ['noise_seed', 'control_after_generate'],
  Flux2Scheduler:             ['steps', 'width', 'height'],
  SamplerCustomAdvanced:      [],
  SaveImage:                  ['filename_prefix'],
  PreviewImage:               [],
  ImageCompositeMasked:       ['x', 'y', 'resize_source'],
  ImageScale:                 ['upscale_method', 'width', 'height', 'crop'],
  ImageScaleBy:               ['upscale_method', 'scale_by'],
  ImageToMask:                ['channel'],
  EmptyFlux2LatentImage:      ['width', 'height', 'batch_size'],
  EmptyLatentImage:           ['width', 'height', 'batch_size'],
  LatentRotate:               ['rotation'],
  LatentFlip:                 ['flip_method'],
  ImageFlip:                  ['flip_method'],
  ImageBatch:                 ['batch_size'],
  SetLatentNoiseMask:         ['grow_mask_by'],
  // Mask utility nodes added in updated workflow template
  MaskComposite:              ['x', 'y', 'operation'],
  SolidMask:                  ['value', 'width', 'height'],
  InvertMask:                 [],
  MaskToImage:                [],
  // Nodes that appear inside steal_tattoo.json subgraphs
  PrimitiveInt:               ['value', 'control_after_generate'],
  ImageScaleToTotalPixels:    ['upscale_method', 'megapixels', 'batch_size'],
  ConditioningZeroOut:        [],
  LoraLoader:                 ['lora_name', 'strength_model', 'strength_clip'],
};

// Custom / community nodes that appear in `final.json`.
// Add more here as needed.
const CUSTOM_WIDGET_NAMES = {
  // Intentionally empty: 'easy imageRemBg' is exported by final.json [1]
  // with a non-standard widget ordering that doesn't match the installed
  // comfyui-easy-use version. Sending positional arg_N values lets ComfyUI
  // accept them and resolve by slot index rather than by (mis-)named key.
};

function widgetNamesFor(nodeType) {
  if (WIDGET_NAMES[nodeType]) return WIDGET_NAMES[nodeType];
  if (CUSTOM_WIDGET_NAMES[nodeType]) return CUSTOM_WIDGET_NAMES[nodeType];
  // Unknown type — fall back to positional arg_N names so nothing is dropped.
  return null;
}

// ---------------------------------------------------------------------------
// Subgraph expander
//
// ComfyUI workflows saved with the LiteGraph 0.13 UI can contain "subgraph"
// nodes whose class_type is a UUID rather than a registered node type.  The
// UUID resolves to a subgraph definition stored in workflow.definitions.subgraphs.
// ComfyUI's own frontend expands these inline before POSTing to /prompt; the
// /prompt endpoint never receives GUID class_types.  We do the same here.
//
// Each subgraph definition has:
//   - id:         the UUID used as class_type in the top-level nodes array
//   - inputNode:  virtual node with id -10 (source of all subgraph inputs)
//   - outputNode: virtual node with id -20 (sink of all subgraph outputs)
//   - inputs[]:   {name, type, linkIds[]} — internal link IDs that leave -10
//   - outputs[]:  {name, type, linkIds[]} — internal link IDs that arrive at -20
//   - nodes[]:    actual internal nodes
//   - links[]:    {id, origin_id, origin_slot, target_id, target_slot, type}
//
// The expander runs iteratively; each pass replaces one subgraph instance
// (the first one found) with its constituent nodes and rewired links.
// Nested subgraphs are therefore expanded in subsequent passes.
// ---------------------------------------------------------------------------
function expandSubgraphs(workflow) {
  if (!workflow || !workflow.definitions ||
      !Array.isArray(workflow.definitions.subgraphs) ||
      workflow.definitions.subgraphs.length === 0) {
    return workflow;
  }

  // Build UUID → subgraph definition lookup
  const sgDefs = new Map();
  for (const sg of workflow.definitions.subgraphs) {
    sgDefs.set(sg.id, sg);
  }

  if (!Array.isArray(workflow.nodes) || !workflow.nodes.some(n => sgDefs.has(n.type))) {
    return workflow; // Nothing to expand
  }

  // Deep-clone so we never mutate the caller's object
  const wf = JSON.parse(JSON.stringify(workflow));

  // Expand one subgraph instance per pass; repeat until none remain.
  // Each pass updates the top-level nodes and links arrays in place.
  let pass = 0;
  while (true) {
    const instIdx = wf.nodes.findIndex(n => sgDefs.has(n.type));
    if (instIdx === -1) break; // All subgraph instances expanded

    if (++pass > 200) {
      const remaining = wf.nodes.filter(n => sgDefs.has(n.type)).map(n => n.type);
      throw new Error('expandSubgraphs: expansion limit exceeded. Remaining GUID nodes: ' + remaining.join(', '));
    }

    const inst = wf.nodes[instIdx];
    const sg   = sgDefs.get(inst.type);

    // Index the current top-level links
    const topLinks = new Map(); // linkId → {srcNode, srcSlot, dstNode, dstSlot, type}
    for (const l of wf.links) {
      topLinks.set(l[0], { srcNode: l[1], srcSlot: l[2], dstNode: l[3], dstSlot: l[4], type: l[5] });
    }

    // What external node+slot feeds each input slot of this subgraph instance?
    const inputSources = []; // [slot] → {srcNode, srcSlot} | null
    for (let i = 0; i < (inst.inputs || []).length; i++) {
      const lId = inst.inputs[i].link;
      if (lId != null && topLinks.has(lId)) {
        const el = topLinks.get(lId);
        inputSources[i] = { srcNode: el.srcNode, srcSlot: el.srcSlot };
      } else {
        inputSources[i] = null;
      }
    }

    // What external node+slot consumes each output slot of this subgraph instance?
    const outputConsumers = []; // [slot] → [{dstNode, dstSlot}]
    for (let i = 0; i < (inst.outputs || []).length; i++) {
      const consumers = [];
      for (const lId of (inst.outputs[i].links || [])) {
        if (topLinks.has(lId)) {
          const el = topLinks.get(lId);
          consumers.push({ dstNode: el.dstNode, dstSlot: el.dstSlot });
        }
      }
      outputConsumers[i] = consumers;
    }

    // Compute ID offsets so remapped internal IDs never collide with existing ones.
    const maxNodeId = Math.max(0, ...wf.nodes.map(n => n.id));
    const maxLinkId = Math.max(0, ...wf.links.map(l => l[0]));
    const nodeOffset = maxNodeId + 1000;
    let nextLinkId   = maxLinkId + 1;

    // internal node id → new top-level node id
    const nodeIdRemap = new Map();
    for (const n of (sg.nodes || [])) {
      nodeIdRemap.set(n.id, nodeOffset + n.id);
    }

    // Build new top-level links and record, for each internal link id, which
    // new top-level link IDs were actually emitted for it.  This authoritative
    // record is used afterwards to update node.inputs[].link and
    // node.outputs[].links so they always reference real, existing link IDs.
    const newLinks = [];                  // new top-level link tuples to add
    const emittedForSgLink = new Map();  // sgLink.id → [new top-level link IDs]

    for (const sgLink of (sg.links || [])) {
      const fromVIn = sgLink.origin_id === -10;
      const toVOut  = sgLink.target_id === -20;
      const emitted = [];

      if (fromVIn && toVOut) {
        // Pass-through: -10 → -20 with no internal node in between
        const src = inputSources[sgLink.origin_slot];
        if (src) {
          for (const c of (outputConsumers[sgLink.target_slot] || [])) {
            const id = nextLinkId++;
            newLinks.push([id, src.srcNode, src.srcSlot, c.dstNode, c.dstSlot, sgLink.type]);
            emitted.push(id);
          }
        }

      } else if (fromVIn) {
        // -10 → internal node: rewire so it comes from the external source
        const src = inputSources[sgLink.origin_slot];
        if (src) {
          const id = nextLinkId++;
          const remappedDst = nodeIdRemap.get(sgLink.target_id) ?? sgLink.target_id;
          newLinks.push([id, src.srcNode, src.srcSlot, remappedDst, sgLink.target_slot, sgLink.type]);
          emitted.push(id);
        }
        // No external source → emitted stays empty → target node's inp.link = null

      } else if (toVOut) {
        // Internal node → -20: fan out to each external consumer of this output slot
        const remappedSrc = nodeIdRemap.get(sgLink.origin_id) ?? sgLink.origin_id;
        for (const c of (outputConsumers[sgLink.target_slot] || [])) {
          const id = nextLinkId++;
          newLinks.push([id, remappedSrc, sgLink.origin_slot, c.dstNode, c.dstSlot, sgLink.type]);
          emitted.push(id);
        }

      } else {
        // Pure internal link: both endpoints are real nodes inside the subgraph
        const id = nextLinkId++;
        const remappedSrc = nodeIdRemap.get(sgLink.origin_id) ?? sgLink.origin_id;
        const remappedDst = nodeIdRemap.get(sgLink.target_id) ?? sgLink.target_id;
        newLinks.push([id, remappedSrc, sgLink.origin_slot, remappedDst, sgLink.target_slot, sgLink.type]);
        emitted.push(id);
      }

      emittedForSgLink.set(sgLink.id, emitted);
    }

    // Clone and remap each internal node.  Use emittedForSgLink to update
    // inp.link and out.links with the IDs that were actually emitted above.
    const remappedNodes = (sg.nodes || []).map(sgNode => {
      const n = JSON.parse(JSON.stringify(sgNode));
      n.id = nodeIdRemap.get(sgNode.id);

      // inp.link: the one link that arrives at this input (or null if dropped)
      for (const inp of (n.inputs || [])) {
        if (inp.link != null) {
          const emitted = emittedForSgLink.get(inp.link) || [];
          inp.link = emitted.length > 0 ? emitted[0] : null;
        }
      }

      // out.links: all links leaving from this output (may fan out via toVOut)
      for (const out of (n.outputs || [])) {
        if (Array.isArray(out.links)) {
          const newOutLinks = [];
          for (const lId of out.links) {
            const emitted = emittedForSgLink.get(lId) || [];
            newOutLinks.push(...emitted);
          }
          out.links = newOutLinks;
        }
      }

      return n;
    });

    // Link IDs to remove: all external links that went to/from the instance
    const removeLinks = new Set();
    for (const inp of (inst.inputs  || [])) { if (inp.link != null) removeLinks.add(inp.link); }
    for (const out of (inst.outputs || [])) { for (const lId of (out.links || [])) removeLinks.add(lId); }

    // Apply mutations
    wf.nodes.splice(instIdx, 1);
    wf.nodes.push(...remappedNodes);
    wf.links = wf.links.filter(l => !removeLinks.has(l[0]));
    wf.links.push(...newLinks);
  }

  return wf;
}

// ---------------------------------------------------------------------------
// Build a link-id -> [src_node_id, src_slot_idx] lookup from the workflow's
// `links` array. Format: [link_id, src_node, src_slot, dst_node, dst_slot, type]
// ---------------------------------------------------------------------------
function buildLinkMap(workflow) {
  const map = new Map();
  const links = Array.isArray(workflow.links) ? workflow.links : [];
  for (const link of links) {
    // Some GUI exports omit link_id and use a 4-tuple; tolerate both.
    const [linkId, srcNode, srcSlot, dstNode, dstSlot, type] = link;
    map.set(linkId, { srcNode: String(srcNode), srcSlot: srcSlot, type: type });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Convert a single GUI-format node into a prompt-format entry.
// Returns null if the node has no class_type (which shouldn't happen but is
// safe to skip — matches ComfyUI's own node_replace_manager behavior).
// ---------------------------------------------------------------------------
function convertNode(node, linkMap) {
  if (!node || !node.type) return null;
  const inputs = {};
  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];

  // Resolve widget refs first (preferred path)
  const usedWidgetIndices = new Set();
  if (Array.isArray(node.inputs)) {
    for (const inp of node.inputs) {
      const name = inp && inp.name;
      if (!name) continue;
      // Linked input (image/latent/etc.) -> [src_node, slot]
      if (typeof inp.link === 'number' && linkMap.has(inp.link)) {
        const link = linkMap.get(inp.link);
        inputs[name] = [link.srcNode, link.srcSlot];
        continue;
      }
      // Widget ref -> take the matching widgets_values entry
      if (inp.widget && typeof inp.widget.name === 'string') {
        const widgetNames = widgetNamesFor(node.type) || [];
        const widgetIndex = widgetNames.indexOf(inp.widget.name);
        if (widgetIndex >= 0 && widgetIndex < widgets.length) {
          inputs[name] = widgets[widgetIndex];
          usedWidgetIndices.add(widgetIndex);
          continue;
        }
      }
      // Otherwise omit (lets the node use its default value).
    }
  }

  // Then sweep through widgets_values[] for any positional entries that
  // weren't already consumed by widget refs. Name them per the type table.
  const widgetNames = widgetNamesFor(node.type);
  if (widgetNames) {
    for (let i = 0; i < widgets.length; i++) {
      if (usedWidgetIndices.has(i)) continue;
      const widgetName = widgetNames[i] || ('arg_' + i);
      // Don't overwrite a value already set from a widget ref.
      if (!(widgetName in inputs)) inputs[widgetName] = widgets[i];
    }
  } else {
    // Unknown node type — expose all widgets positionally so they're not lost.
    for (let i = 0; i < widgets.length; i++) {
      if (usedWidgetIndices.has(i)) continue;
      inputs['arg_' + i] = widgets[i];
    }
  }

  // NOTE: the previous ResizeImageMaskNode shim that force-copied
  // resize_type -> scale_method/resizeType has been removed. In the v3
  // schema `resize_type` and `scale_method` are two DIFFERENT inputs
  // (a DynamicCombo choice vs an interpolation string). Copying one to
  // the other made ComfyUI's DynamicCombo handler fail to match the choice
  // and silently drop the field, which surfaced as
  // "execute() missing 1 required positional argument: 'resize_type'".

  return {
    class_type: node.type,
    inputs: inputs,
  };
}

// ---------------------------------------------------------------------------
// Convert a whole workflow object.
//   gui: { nodes: [...], links: [...], ... }   (final.json shape [1])
//   returns: { "1": {class_type, inputs}, "2": {...}, ... }
// ---------------------------------------------------------------------------
function guiToPrompt(gui) {
  if (!gui || !Array.isArray(gui.nodes)) {
    throw new Error('guiToPrompt: expected object with nodes[]');
  }
  // Expand any subgraph instances (GUID class_types) into their constituent
  // nodes before converting to prompt format.  ComfyUI's /prompt endpoint
  // only accepts flat, registered node types — it never sees GUID types.
  const flat = expandSubgraphs(gui);
  const linkMap = buildLinkMap(flat);
  const prompt = {};
  for (const node of flat.nodes) {
    const entry = convertNode(node, linkMap);
    if (!entry) continue;
    prompt[String(node.id)] = entry;
  }
  return prompt;
}

module.exports = { guiToPrompt, convertNode, buildLinkMap, expandSubgraphs, WIDGET_NAMES };
