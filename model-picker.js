import {commonModelChoice, MODEL_CATALOG} from './lab/table-agents.js';

const modelsById = new Map(MODEL_CATALOG.map(model => [model.id, model]));
const choices = [{id:'random', label:'랜덤', description:'자리마다 등록된 모델 중 하나를 무작위로 배정합니다.'}, ...MODEL_CATALOG];
const escape = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));

export function modelLabel(id) {
  return modelsById.get(id)?.label ?? '알 수 없는 모델';
}

function modelField(current, editable, rowClass) {
  const choice = choices.find(({id}) => id === current) ?? choices[0];
  if (!editable) return '<div class="' + rowClass + '"><strong>전체 AI 모델</strong><span>' + escape(choice.label) + '</span></div>';
  const options = choices.map(({id, label, description}) => '<option value="' + escape(id) + '" title="' + escape(description) + '"' +
    (id === choice.id ? ' selected' : '') + '>' + escape(label) + '</option>').join('');
  return '<label class="' + rowClass + '"><strong>전체 AI 모델</strong><select id="model-all" name="modelChoice" data-ai-all>' + options + '</select></label>';
}

export function modelSettings(current = 'random', editable = true) {
  return '<fieldset class="model-settings"><legend>AI 플레이어</legend>' + modelField(current, editable, 'model-row') + '</fieldset>';
}

export function roomModelOption(snapshot, editable) {
  if (!editable && !snapshot.botModels) return '';
  const current = snapshot.modelChoice ?? commonModelChoice(snapshot.botModels);
  return modelField(current, editable, 'room-game-option');
}

export function modelSummary(snapshot) {
  if (!snapshot?.botModels) return '';
  if (!snapshot.game) return modelSettings(snapshot.modelChoice ?? commonModelChoice(snapshot.botModels), false);
  const rows = snapshot.botModels.map((id, seat) => {
    const player = snapshot.players[seat];
    if (!player?.bot) return '';
    const caption = (seat + 1) + '번 · ' + player.name;
    return '<div data-model-seat="' + seat + '"><dt>' + escape(caption) + '</dt><dd>' + escape(modelLabel(id)) + '</dd></div>';
  }).join('');
  return rows ? '<section class="model-summary"><h3>자리별 AI 모델</h3><dl>' + rows + '</dl></section>' : '';
}
