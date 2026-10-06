/* global document, fetch, location, history, URLSearchParams, setTimeout */
const byId = (id) => document.getElementById(id);
const element = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const dollars = (amount) => new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}).format(amount / 100);
let recording;
let scenario = 'injection';
let selected;
let playback = 0;

function renderEvent(event) {
  const row = element('article', '', 'event ' + event.status);
  row.append(element('small', event.kind), element('h3', event.title));
  if (event.data !== undefined) {
    const detail = document.createElement('details');
    detail.append(element('summary', 'Inspect evidence'), element('pre', JSON.stringify(event.data, null, 2)));
    row.append(detail);
  }
  byId('trace').append(row);
}
function renderLedger(id, rows, projected) {
  byId(id).replaceChildren();
  for (const row of rows) {
    const card = element('div', '', 'payment' + (row.refunded ? ' changed' : '') + (projected ? ' projected' : ''));
    card.append(element('span', row.transactionId), element('strong', dollars(row.amountCents)), element('small', row.refunded ? (projected ? 'WOULD BE REFUNDED' : 'REFUNDED IN RECORD') : 'CHARGED'));
    byId(id).append(card);
  }
}
function chooseRun(run) {
  playback++;
  selected = run;
  byId('play').disabled = false;
  byId('trace').replaceChildren();
  const events = run.result ? run.result.events : run.partialEvents;
  for (const event of events) renderEvent(event);
  byId('runStatus').textContent = 'RECORDED · ' + run.id;
  byId('proofs').replaceChildren();
  const assertions = run.assertions;
  const proofs = [
    ['Wrong target unchanged', assertions.wrongTargetUnchanged],
    ['Consumed before execution', assertions.consumedBeforeExecution],
    ['Replay rejected · 409', assertions.replayRejected],
    ['Policy / intent hold', assertions.policyOrIntentHeld]
  ];
  for (const [name, passed] of proofs) if (passed !== null) byId('proofs').append(element('span', name + (passed ? ' ✓' : ' · not established'), 'proof' + (passed ? '' : ' warning')));
  if (!assertions.desiredOutcomeObserved) byId('proofs').append(element('span', 'Desired demo outcome not established', 'proof warning'));
  if (!run.result) {
    byId('guardedLedger').replaceChildren(element('p', 'Complete ledger unavailable for this capture.'));
    byId('projectedLedger').replaceChildren(element('p', 'No complete result; projection omitted.'));
    byId('projectionNote').textContent = run.error;
    byId('executions').textContent = run.status.toUpperCase();
  } else {
    renderLedger('guardedLedger', run.result.ledger, false);
    const first = events.find((event) => event.kind === 'proposal')?.data;
    const projected = run.result.ledger.map((row) => ({ ...row, refunded: Boolean(first && row.transactionId === first.transactionId && row.amountCents === first.amountCents) }));
    renderLedger('projectedLedger', projected, true);
    byId('projectionNote').textContent = first ? 'Projection assumes the first proposed full-amount refund ran with no authorization check. Seeded mistakes are not natural planner error rates.' : 'The agent asked for clarification; there was no refund proposal to project.';
    byId('executions').textContent = run.result.executions + ' RECORDED EXECUTION' + (run.result.executions === 1 ? '' : 'S');
  }
  history.replaceState(null, '', '?' + new URLSearchParams({run:run.id}));
}
function chooseScenario(value, preferredId) {
  scenario = value;
  for (const button of document.querySelectorAll('.scenario')) { const active = button.dataset.scenario === scenario; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  const runs = recording.runs.filter((run) => run.scenario === scenario);
  byId('round').replaceChildren();
  for (const run of runs) { const option = element('option', 'Round ' + run.round + ' · ' + (run.assertions.desiredOutcomeObserved ? 'expected outcome observed' : run.status + ' / inspect outcome')); option.value = run.id; byId('round').append(option); }
  const run = runs.find((item) => item.id === preferredId) || runs[0];
  byId('round').value = run.id;
  chooseRun(run);
}
for (const button of document.querySelectorAll('.scenario')) button.addEventListener('click', () => { if (recording) chooseScenario(button.dataset.scenario); });
byId('round').addEventListener('change', () => chooseRun(recording.runs.find((run) => run.id === byId('round').value)));
byId('play').addEventListener('click', async () => {
  const generation = ++playback;
  const events = selected.result ? selected.result.events : selected.partialEvents;
  byId('play').disabled = true; byId('trace').replaceChildren(); byId('runStatus').textContent = 'REPLAYING RECORD · NO EXECUTION';
  for (const event of events) {
    if (generation !== playback) return;
    renderEvent(event);
    byId('trace').scrollTop = byId('trace').scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  if (generation === playback) { byId('play').disabled = false; byId('runStatus').textContent = 'RECORDED · ' + selected.id; }
});
async function load() {
  const response = await fetch('recording.json', {redirect:'error'});
  if (!response.ok) throw new Error('Recording unavailable');
  recording = await response.json();
  if (recording.schemaVersion !== 1 || recording.provider !== 'nebius' || !recording.budget.closed) throw new Error('Invalid recording');
  byId('recordedAt').textContent = 'Captured ' + recording.createdAt.replace('T', ' ').replace('Z', ' UTC') + '. Synthetic sandbox; no real money moves.';
  byId('caseCount').textContent = recording.runs.length + ' / ' + recording.rounds + ' rounds';
  byId('outcomes').textContent = recording.runs.filter((run) => run.assertions.desiredOutcomeObserved).length + ' expected demo outcomes; not accuracy';
  byId('model').textContent = recording.budget.model;
  byId('cost').textContent = '$' + recording.budget.chargedEstimateUsd.toFixed(7);
  byId('budget').textContent = recording.budget.requests.length + ' inference calls · $' + recording.budget.capUsd.toFixed(2) + ' batch cap';
  const latencies = recording.budget.requests.filter((request) => request.status === 'completed' && typeof request.latencyMs === 'number').map((request) => request.latencyMs).sort((a,b) => a-b);
  const middle = Math.floor(latencies.length / 2);
  const median = latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2;
  byId('latency').textContent = latencies.length ? (median / 1000).toFixed(2) + 's median' : 'Unknown';
  byId('tokens').textContent = recording.budget.inputTokens.toLocaleString('en-US') + ' input / ' + recording.budget.outputTokens.toLocaleString('en-US') + ' output tokens';
  byId('accountingNote').textContent = 'This batch reserved full model context plus output capacity before each request, then settled known token usage. It is closed. Retained unknown-cost reservations: $' + recording.budget.retainedReservationUsd.toFixed(7) + '. This is a batch estimate, not a wallet balance or account-wide billing limit.';
  const initial = recording.runs.find((run) => run.id === new URLSearchParams(location.search).get('run'));
  chooseScenario(initial ? initial.scenario : scenario, initial?.id);
}
load().catch(() => { byId('recordedAt').textContent = 'Recording unavailable. Use the public source test build.'; byId('runStatus').textContent = 'UNAVAILABLE'; });
