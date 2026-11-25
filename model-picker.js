import {DEFAULT_MODEL, MODEL_CATALOG} from './lab/table-agents.js';

const defaultSeats = () => Array(5).fill(DEFAULT_MODEL);
const modelsById = new Map(MODEL_CATALOG.map(model => [model.id, model]));
const resultsLink = '<a class="model-results" href="https://github.com/schoimath/mighty-online/blob/main/lab/results-live/final_test.md" target="_blank" rel="noopener noreferrer">모델별 대국 성적 ↗</a>';
const escape = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));

export function modelLabel(id) {
  return modelsById.get(id)?.label ?? '알 수 없는 모델';
}

function options(current) {
  return MODEL_CATALOG.map(({id, label}) =>
    '<option value="' + escape(id) + '"' + (current === id ? ' selected' : '') + '>' + escape(label) + '</option>').join('');
}

function commonModel(models, hostSeat) {
  const others = models.filter((_, index) => index !== hostSeat);
  return others.every(id => id === others[0]) ? others[0] : '';
}

function description(id) {
  return modelsById.get(id)?.description ?? '자리별로 다른 모델을 사용합니다.';
}

export function modelSettings(models = defaultSeats(), hostSeat = 0, players = []) {
  const shared = commonModel(models, hostSeat);
  const rows = models.map((model, seat) => {
    if (seat === hostSeat) return '<input type="hidden" data-ai-seat="' + seat + '" value="' + escape(model) + '">';
    const note = players[seat] ? escape(players[seat].name) + '님이 나가면 참가' : 'AI 참가';
    return '<label class="model-row"><span><strong>' + (seat + 1) + '번 자리</strong><small>' + note + '</small></span>' +
      '<select id="model-seat-' + seat + '" data-ai-seat="' + seat + '" aria-label="' + (seat + 1) + '번 자리 AI 모델">' + options(model) + '</select></label>';
  }).join('');
  return '<fieldset class="model-settings"><legend>AI 플레이어</legend>' +
    '<label class="model-row"><strong>전체 AI 모델</strong><select id="model-all" data-ai-all><option value="" disabled' +
    (shared ? '' : ' selected') + '>자리별 설정</option>' + options(shared) + '</select></label>' +
    '<p class="model-description" aria-live="polite">' + escape(description(shared)) + '</p>' +
    '<details class="model-details"><summary>자리별 AI 선택</summary>' + rows + '</details>' + resultsLink + '</fieldset>';
}

export function readModelSettings(container) {
  return Array.from(container.querySelectorAll('[data-ai-seat]'), field => field.value);
}

export function bindModelSettings(container, hostSeat = 0, onChange) {
  const group = container.querySelector('.model-settings');
  const all = group.querySelector('[data-ai-all]');
  group.onchange = event => {
    if (event.target === all) {
      for (const field of group.querySelectorAll('[data-ai-seat]')) field.value = all.value;
    }
    const models = readModelSettings(group);
    all.value = commonModel(models, hostSeat);
    group.querySelector('.model-description').textContent = description(all.value);
    onChange?.(models);
  };
}

export function modelSummary(snapshot) {
  if (!snapshot?.botModels) return '';
  const rows = snapshot.botModels.map((id, seat) => {
    const player = snapshot.players[seat];
    if (seat === snapshot.hostSeat || (snapshot.game && !player?.bot)) return '';
    const caption = (seat + 1) + '번' + (player ? ' · ' + player.name : ' 자리');
    return '<div data-model-seat="' + seat + '"><dt>' + escape(caption) + '</dt><dd>' + escape(modelLabel(id)) + '</dd></div>';
  }).join('');
  return rows ? '<section class="model-summary"><h3>자리별 AI 모델</h3><dl>' + rows + '</dl>' + resultsLink + '</section>' : '';
}
