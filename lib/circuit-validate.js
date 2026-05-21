// ── Circuit validator (structural / electrical lint) ────────────────────
// Returns { ok, errors, warnings, stats } without doing any simulation.

import { buildGraph, findPowerShorts, findIslands } from './circuit-graph.js';

export function validateCircuit(doc) {
  const graph = buildGraph(doc);
  const errors = [...graph.errors];
  const warnings = [...graph.warnings];

  if (graph.components.size === 0 && errors.length === 0) {
    warnings.push({ code: 'EMPTY_CIRCUIT', message: 'no components in circuit' });
  }

  // ── POWER_SHORT: VCC tied to GND through wires only ──────────────────
  const shortedRoots = findPowerShorts(graph);
  if (shortedRoots.length > 0) {
    errors.push({
      code: 'POWER_SHORT',
      message: 'VCC and GND are connected through wires with no impedance in between',
      roots: shortedRoots.length,
    });
  }

  // ── DANGLING_PIN: pin not in any wire ────────────────────────────────
  // A pin is dangling if its net has only one pin total (itself) AND the component isn't a single-pin power rail (vcc/gnd).
  for (const [netId, net] of graph.nets) {
    if (net.pins.length === 1) {
      const { compId, pinName } = net.pins[0];
      const c = graph.components.get(compId);
      if (c._sym.isPower) continue; // a free VCC/GND symbol is fine on its own
      warnings.push({
        code: 'DANGLING_PIN',
        message: `pin ${compId}.${pinName} is not wired to anything`,
        component: compId,
        pin: pinName,
      });
    }
  }

  // ── FLOATING_ISLAND: subgraph that never touches VCC or GND ──────────
  const islands = findIslands(graph);
  for (const island of islands) {
    if (island.length === 1) {
      // Single-component island is often just a stub — skip if it has no wires at all.
      const id = island[0];
      const c = graph.components.get(id);
      // Already covered by dangling-pin; skip
      if (c._sym.isPower) continue;
    }
    warnings.push({
      code: 'FLOATING_ISLAND',
      message: 'group of components with no path to VCC or GND',
      components: island,
    });
  }

  // ── DUP_DRIVER: two output-typed pins on the same net ────────────────
  for (const [netId, net] of graph.nets) {
    const drivers = net.pins.filter(({ compId, pinName }) => {
      const c = graph.components.get(compId);
      const pin = c._sym.pins[pinName];
      return pin && pin.dir === 'out';
    });
    if (drivers.length > 1) {
      warnings.push({
        code: 'DUP_DRIVER',
        message: `net ${netId} has ${drivers.length} output pins tied together`,
        net: netId,
        drivers: drivers.map(d => `${d.compId}.${d.pinName}`),
      });
    }
  }

  // ── OVERFANOUT ───────────────────────────────────────────────────────
  for (const [netId, net] of graph.nets) {
    if (net.pins.length > 8 && !net.isPower) {
      warnings.push({
        code: 'OVERFANOUT',
        message: `net ${netId} has ${net.pins.length} connections`,
        net: netId,
        connections: net.pins.length,
      });
    }
  }

  // ── POLARITY (heuristic) ─────────────────────────────────────────────
  // For polarized two-pin components with named +/- pins, check that the + pin's
  // net is "more VCC-ish" than the - pin's net.
  for (const [id, c] of graph.components) {
    if (!c._sym.polarized) continue;
    const pinNames = Object.keys(c._sym.pins);
    if (pinNames.length !== 2) continue;
    const [pinA, pinB] = pinNames;
    const netA = graph.nets.get(graph.pinToNet.get(`${id}.${pinA}`));
    const netB = graph.nets.get(graph.pinToNet.get(`${id}.${pinB}`));
    if (!netA || !netB) continue;
    // Heuristic only for components whose first pin should be the positive one.
    // capacitor_pol.pos / diode.a / led.a / vsource.pos
    const posPinNames = { capacitor_pol: 'pos', diode: 'a', led: 'a', vsource: 'pos' };
    const expectedPosPin = posPinNames[c.type];
    if (!expectedPosPin) continue;
    const posNet = graph.nets.get(graph.pinToNet.get(`${id}.${expectedPosPin}`));
    const otherPin = pinNames.find(p => p !== expectedPosPin);
    const negNet = graph.nets.get(graph.pinToNet.get(`${id}.${otherPin}`));
    if (!posNet || !negNet) continue;
    if (posNet.isPower === 'GND' && negNet.isPower === 'VCC') {
      warnings.push({
        code: 'POLARITY_REVERSED',
        message: `${c.type} ${id} has + pin on GND and - pin on VCC`,
        component: id,
      });
    }
  }

  // ── MISSING_DECOUPLING (lint for opamp / ic) ─────────────────────────
  for (const [id, c] of graph.components) {
    if (c.type !== 'opamp') continue;
    const vccNet = graph.nets.get(graph.pinToNet.get(`${id}.vcc`));
    const veeNet = graph.nets.get(graph.pinToNet.get(`${id}.vee`));
    if (!vccNet || !veeNet) continue;
    const hasCapBetween = anyCapBetween(graph, vccNet.id, veeNet.id);
    if (!hasCapBetween) {
      warnings.push({
        code: 'MISSING_DECOUPLING',
        message: `${id} (${c.type}) has no decoupling capacitor between VCC and VEE/GND`,
        component: id,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      components: graph.components.size,
      nets: graph.nets.size,
      wires: Array.isArray(doc?.wires) ? doc.wires.length : 0,
    },
  };
}

function anyCapBetween(graph, netA, netB) {
  for (const [id, c] of graph.components) {
    if (c.type !== 'capacitor' && c.type !== 'capacitor_pol') continue;
    const pinNames = Object.keys(c._sym.pins);
    const n1 = graph.pinToNet.get(`${id}.${pinNames[0]}`);
    const n2 = graph.pinToNet.get(`${id}.${pinNames[1]}`);
    if ((n1 === netA && n2 === netB) || (n1 === netB && n2 === netA)) return true;
  }
  return false;
}
