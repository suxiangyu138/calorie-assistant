const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, high: 1.725 };
const ACTIVITY_LABELS = { sedentary: '久坐', light: '轻度', moderate: '中度', high: '高度' };
const GOAL_FACTOR = { cut: 0.82, maintain: 1.0, gain: 1.1 };
const GOAL_LABELS = { cut: '减脂', maintain: '维持', gain: '增肌' };
const SEX_LABELS = { male: '男', female: '女' };
const MEAL_TYPES = [['breakfast', '早餐'], ['lunch', '午餐'], ['dinner', '晚餐'], ['snack', '加餐']];
const MEAL_LABELS = Object.fromEntries(MEAL_TYPES);

const isNative = /CalorieApp/.test(navigator.userAgent);
const CHAT_URL = isNative ? '/api/analyze' : 'https://api.deepseek.com/chat/completions';
const MODELS_URL = isNative ? '/api/models' : 'https://api.deepseek.com/models';
const MODEL = 'deepseek-flash';
const RECOGNIZE_PROMPT = `分析这张食物照片。只返回 JSON，不要任何其他文字，不要 markdown 代码块。
格式为 {"items":[{"name":"食物名","grams":数字,"calories":数字,"protein":数字,"fat":数字,"carbs":数字}],"confidence":"high|medium|low","note":"不确定因素的简短说明"}
如果没有识别到食物，返回 {"items":[],"confidence":"low","note":"未识别到食物"}`;

const $ = (id) => document.getElementById(id);
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const state = {
  profile: null,
  metrics: null,
  date: todayStr(),
  view: 'home',
  stream: null,
  sheet: { mode: 'manual', items: [], note: '', raw: '', mealType: 'lunch', editingId: null, date: null }
};

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function fmtDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

function fmtWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

function fmtShort(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

function display(value) {
  return Math.round(num(value)).toLocaleString('zh-CN');
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function computeMetrics(p) {
  const heightM = p.height / 100;
  const bmi = p.weight / (heightM * heightM);
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'male' ? 5 : -161);
  const formulaTdee = bmr * ACTIVITY[p.activity];
  const personaActive = !!(p.persona && p.persona.tdee > 0);
  const tdee = personaActive ? p.persona.tdee : formulaTdee;
  let target = tdee;
  if (p.goal === 'cut') target = tdee - p.deficit;
  if (p.goal === 'gain') target = tdee * GOAL_FACTOR.gain;
  const floor = bmr * 1.1;
  const clamped = target < floor;
  if (clamped) target = floor;
  const gap = tdee - target;
  const protein = p.weight * p.proteinFactor;
  const fatByRatio = (target * p.fatRatio) / 9;
  const fatMin = p.weight * 0.6;
  const fatMax = p.weight * 1.0;
  let fat = fatByRatio;
  let fatGuard = 0;
  if (fat < fatMin) { fat = fatMin; fatGuard = -1; }
  else if (fat > fatMax) { fat = fatMax; fatGuard = 1; }
  const carbs = Math.max(0, (target - protein * 4 - fat * 9) / 4);
  const carbsPerKg = p.weight > 0 ? carbs / p.weight : 0;
  const gapRatio = tdee > 0 ? gap / tdee : 0;
  const heavy = !clamped && gapRatio > 0.25;
  const small = !clamped && p.goal === 'cut' && gapRatio > 0 && gapRatio < 0.15;
  return {
    bmi: round(bmi, 2),
    bmr: round(bmr, 2),
    tdee: round(tdee, 2),
    formulaTdee: round(formulaTdee, 2),
    personaActive,
    target: round(target, 2),
    gap: round(gap, 2),
    protein: round(protein, 2),
    fat: round(fat, 2),
    carbs: round(carbs, 2),
    gapRatio: round(gapRatio, 4),
    carbsPerKg: round(carbsPerKg, 2),
    clamped,
    heavy,
    small,
    fatGuard
  };
}

function loadProfile() {
  try {
    const raw = localStorage.getItem('profile');
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.height || !p.weight) return null;
    const goal = GOAL_FACTOR[p.goal] ? p.goal : 'cut';
    return {
      height: num(p.height), weight: num(p.weight), age: num(p.age, 22),
      sex: p.sex === 'female' ? 'female' : 'male',
      activity: ACTIVITY[p.activity] ? p.activity : 'sedentary',
      goal,
      deficit: Number.isFinite(Number(p.deficit)) ? Number(p.deficit) : 400,
      proteinFactor: Number.isFinite(Number(p.proteinFactor)) ? Number(p.proteinFactor) : (goal === 'cut' ? 1.8 : 1.6),
      fatRatio: Number.isFinite(Number(p.fatRatio)) ? Number(p.fatRatio) : 0.25,
      persona: p.persona && Number.isFinite(Number(p.persona.tdee)) && Number(p.persona.tdee) > 0
        ? {
            text: String(p.persona.text || ''),
            tdee: Number(p.persona.tdee),
            activity: ACTIVITY[p.persona.activity] ? p.persona.activity : null,
            note: String(p.persona.note || '')
          }
        : null,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : ''
    };
  } catch (e) {
    return null;
  }
}

function persistProfile() {
  localStorage.setItem('profile', JSON.stringify({
    height: state.profile.height, weight: state.profile.weight, age: state.profile.age,
    sex: state.profile.sex, activity: state.profile.activity, goal: state.profile.goal,
    deficit: state.profile.deficit, proteinFactor: state.profile.proteinFactor,
    fatRatio: state.profile.fatRatio,
    persona: state.profile.persona,
    apiKey: state.profile.apiKey
  }));
}

const DEFAULT_PROFILE = { height: 175, weight: 65, age: 22, sex: 'male', activity: 'sedentary', goal: 'cut', deficit: 400, proteinFactor: 1.8, fatRatio: 0.25, persona: null, apiKey: '' };
let draft = { ...DEFAULT_PROFILE };

async function init() {
  bindStaticEvents();
  state.profile = loadProfile();
  if (!state.profile) {
    draft = { ...DEFAULT_PROFILE };
    showOnboarding();
    return;
  }
  state.metrics = computeMetrics(state.profile);
  showApp();
  await renderHome();
}

function showOnboarding() {
  $('onboarding').classList.remove('hidden');
  $('app').classList.add('hidden');
  renderOnboardingForm();
}

function renderOnboardingForm() {
  const rows = [
    ['height', '身高', `${draft.height} cm`],
    ['weight', '体重', `${draft.weight} kg`],
    ['age', '年龄', `${draft.age} 岁`],
    ['sex', '性别', SEX_LABELS[draft.sex]],
    ['activity', '活动水平', ACTIVITY_LABELS[draft.activity]],
    ['goal', '目标', GOAL_LABELS[draft.goal]],
    ['deficit', '每日热量缺口', draft.goal === 'cut' ? `${draft.deficit} kcal` : '仅减脂生效']
  ];
  const box = $('onboardingForm');
  box.innerHTML = rows.map(([key, label, value]) => `
    <button class="row" data-field="${key}">
      <span class="k">${label}</span>
      <span class="v">${value}${chevron()}</span>
    </button>
  `).join('');
  box.querySelectorAll('[data-field]').forEach((btn) => {
    btn.addEventListener('click', () => editField(btn.dataset.field, draft, () => renderOnboardingForm()));
  });
}

function chevron() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 6l6 6-6 6"/></svg>';
}

function editField(key, target, done) {
  if (key === 'height' || key === 'weight' || key === 'age') {
    const meta = { height: ['身高', 'cm'], weight: ['体重', 'kg'], age: ['年龄', '岁'] }[key];
    promptNumber({
      title: meta[0], value: target[key], unit: meta[1],
      onOk: (value) => {
        target[key] = value;
        done();
      }
    });
    return;
  }
  if (key === 'sex') {
    promptChoice({ title: '性别', value: target.sex, options: [['male', '男'], ['female', '女']], onOk: (v) => { target.sex = v; done(); } });
    return;
  }
  if (key === 'activity') {
    promptChoice({
      title: '活动水平', value: target.activity,
      options: [
        ['sedentary', '久坐', '几乎不运动，坐着的时间长'],
        ['light', '轻度', '每周 1–3 次轻运动'],
        ['moderate', '中度', '每周 3–5 次力量或有氧'],
        ['high', '高度', '每周 6 次以上，或体力工作']
      ],
      onOk: (v) => { target.activity = v; done(); }
    });
    return;
  }
  if (key === 'goal') {
    promptChoice({
      title: '目标', value: target.goal,
      options: [['cut', '减脂'], ['maintain', '维持'], ['gain', '增肌']],
      onOk: (v) => {
        const oldDefault = target.goal === 'cut' ? 1.8 : 1.6;
        if (Math.abs(target.proteinFactor - oldDefault) < 0.001) {
          target.proteinFactor = v === 'cut' ? 1.8 : 1.6;
        }
        target.goal = v;
        done();
      }
    });
    return;
  }
  if (key === 'deficit') {
    if (target.goal !== 'cut') { toast('热量缺口只在减脂目标下生效'); return; }
    promptChoice({
      title: '每日热量缺口',
      value: String(target.deficit),
      options: [['300', '300 kcal'], ['400', '400 kcal'], ['450', '450 kcal'], ['500', '500 kcal'], ['custom', '自定义']],
      onOk: (v) => {
        if (v === 'custom') {
          promptNumber({
            title: '自定义缺口', value: target.deficit, unit: 'kcal',
            onOk: (input) => { target.deficit = Math.min(1500, Math.round(input)); done(); }
          });
          return;
        }
        target.deficit = Number(v);
        done();
      }
    });
    return;
  }
  if (key === 'proteinFactor') {
    promptChoice({
      title: '蛋白质系数',
      value: String(target.proteinFactor),
      options: [['1.2', '1.2 g/kg'], ['1.6', '1.6 g/kg'], ['1.8', '1.8 g/kg'], ['2', '2.0 g/kg'], ['custom', '自定义']],
      onOk: (v) => {
        if (v === 'custom') {
          promptNumber({
            title: '自定义蛋白质系数', value: target.proteinFactor, unit: 'g/kg',
            onOk: (input) => { target.proteinFactor = Math.min(3, Math.max(0.8, input)); done(); }
          });
          return;
        }
        target.proteinFactor = Number(v);
        done();
      }
    });
    return;
  }
  if (key === 'fatRatio') {
    promptChoice({
      title: '脂肪占比',
      value: String(Math.round(target.fatRatio * 100)),
      options: [['20', '20%'], ['22', '22%'], ['25', '25%'], ['30', '30%'], ['custom', '自定义']],
      onOk: (v) => {
        if (v === 'custom') {
          promptNumber({
            title: '自定义脂肪占比', value: Math.round(target.fatRatio * 100), unit: '%',
            onOk: (input) => { target.fatRatio = Math.min(0.45, Math.max(0.15, input / 100)); done(); }
          });
          return;
        }
        target.fatRatio = Number(v) / 100;
        done();
      }
    });
    return;
  }
}

function promptNumber({ title, value, unit, onOk }) {
  openDialog({
    title,
    body: `<input id="dialogInput" class="dialog-input" type="number" inputmode="decimal" value="${Number(value)}">`,
    onOpen: () => {
      const input = $('dialogInput');
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('dialogOk').click(); });
    },
    onOk: () => {
      const v = Number($('dialogInput').value);
      if (!Number.isFinite(v) || v <= 0) { toast('请输入有效数字'); return false; }
      onOk(round(v, 2));
      return true;
    }
  });
  if (unit) $('dialogTitle').textContent = `${title}（${unit}）`;
}

function promptChoice({ title, value, options, onOk }) {
  openDialog({
    title,
    body: `<div class="dialog-options">${options.map(([k, label, desc]) => `
      <button class="dialog-option ${k === value ? 'on' : ''}" data-value="${k}">
        <span class="dialog-option-text">${label}${desc ? `<span class="dialog-option-desc">${desc}</span>` : ''}</span>
        ${k === value ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12l5 5 9-10"/></svg>' : ''}
      </button>`).join('')}</div>`,
    onOpen: () => {
      $('dialogBody').querySelectorAll('.dialog-option').forEach((btn) => {
        btn.addEventListener('click', () => { closeDialog(); onOk(btn.dataset.value); });
      });
      $('dialogOk').classList.add('hidden');
      $('dialogCancel').textContent = '关闭';
    },
    hideOk: true
  });
}

function confirmDialog({ title, text, okText = '确定', onOk }) {
  openDialog({
    title,
    body: `<p>${text}</p>`,
    okText,
    onOk: () => { onOk(); return true; }
  });
}

function openDialog({ title, body, okText = '确定', hideOk = false, onOk, onOpen }) {
  $('dialogTitle').textContent = title;
  $('dialogBody').innerHTML = body;
  $('dialogOk').textContent = okText;
  $('dialogOk').classList.toggle('hidden', hideOk);
  $('dialogCancel').textContent = '取消';
  $('dialog').classList.remove('hidden');
  $('dialogOk').onclick = () => {
    const result = onOk ? onOk() : true;
    if (result && typeof result.then === 'function') {
      result.then((value) => { if (value !== false) closeDialog(); });
      return;
    }
    if (result !== false) closeDialog();
  };
  if (onOpen) requestAnimationFrame(onOpen);
}

function closeDialog() {
  $('dialog').classList.add('hidden');
  $('dialogOk').classList.remove('hidden');
  $('dialogCancel').textContent = '取消';
}

function showApp() {
  $('onboarding').classList.add('hidden');
  $('app').classList.remove('hidden');
  switchView('home');
}

function switchView(view) {
  state.view = view;
  ['home', 'camera', 'stats', 'settings'].forEach((name) => {
    $('view-' + name).classList.toggle('hidden', name !== view);
  });
  window.scrollTo(0, 0);
}

function bindStaticEvents() {
  $('onboardingSave').addEventListener('click', saveOnboarding);
  $('prevDay').addEventListener('click', () => changeDay(-1));
  $('nextDay').addEventListener('click', () => changeDay(1));
  $('dayTitle').addEventListener('click', openDatePicker);
  $('dateMask').addEventListener('click', closeDatePicker);
  $('datePrev').addEventListener('click', () => shiftPickerMonth(-1));
  $('dateNext').addEventListener('click', () => shiftPickerMonth(1));
  $('dateToday').addEventListener('click', () => {
    state.date = todayStr();
    closeDatePicker();
    renderHome();
  });
  $('btnStats').addEventListener('click', openStats);
  $('btnSettings').addEventListener('click', () => { switchView('settings'); renderSettings(); });
  $('statsBack').addEventListener('click', () => switchView('home'));
  $('settingsBack').addEventListener('click', () => switchView('home'));
  $('btnWeight').addEventListener('click', askWeight);
  $('fab').addEventListener('click', openCamera);
  $('camBack').addEventListener('click', () => { stopCamera(); switchView('home'); });
  $('btnShutter').addEventListener('click', onShutter);
  $('btnGallery').addEventListener('click', () => $('fileInput').click());
  $('btnManual').addEventListener('click', () => { stopCamera(); switchView('home'); openSheet('manual'); });
  $('fileInput').addEventListener('change', onPickPhoto);
  $('importInput').addEventListener('change', onPickImport);
  $('sheetMask').addEventListener('click', closeSheet);
  $('sheetCancel').addEventListener('click', closeSheet);
  $('sheetOk').addEventListener('click', saveSheet);
  $('sheetExtra').addEventListener('click', addSheetItem);
  $('dialogMask').addEventListener('click', closeDialog);
  $('dialogCancel').addEventListener('click', closeDialog);
  window.__onBack = handleBack;
}

function handleBack() {
  if (!$('dialog').classList.contains('hidden')) { closeDialog(); return true; }
  if (!$('datePicker').classList.contains('hidden')) { closeDatePicker(); return true; }
  if (!$('sheet').classList.contains('hidden')) { closeSheet(); return true; }
  if (state.view === 'camera') { stopCamera(); switchView('home'); return true; }
  if (state.view === 'stats' || state.view === 'settings') { switchView('home'); return true; }
  return false;
}

function saveOnboarding() {
  if (!draft.height || !draft.weight || !draft.age) {
    toast('请先填完身体信息');
    return;
  }
  state.profile = { ...draft };
  persistProfile();
  state.metrics = computeMetrics(state.profile);
  showApp();
  renderHome();
}

function changeDay(offset) {
  const next = shiftDate(state.date, offset);
  if (next > todayStr()) return;
  state.date = next;
  renderHome();
}

const picker = { year: 0, month: 0 };

function openDatePicker() {
  const [year, month] = state.date.split('-').map(Number);
  picker.year = year;
  picker.month = month;
  renderDatePicker();
  $('datePicker').classList.remove('hidden');
  $('datePicker').classList.add('closing');
  requestAnimationFrame(() => requestAnimationFrame(() => $('datePicker').classList.remove('closing')));
}

function closeDatePicker() {
  $('datePicker').classList.add('closing');
  setTimeout(() => {
    $('datePicker').classList.add('hidden');
    $('datePicker').classList.remove('closing');
  }, 240);
}

function shiftPickerMonth(delta) {
  let year = picker.year;
  let month = picker.month + delta;
  if (month < 1) { month = 12; year -= 1; }
  if (month > 12) { month = 1; year += 1; }
  picker.year = year;
  picker.month = month;
  renderDatePicker();
}

function renderDatePicker() {
  const year = picker.year;
  const month = picker.month;
  const today = todayStr();
  const [todayYear, todayMonth] = today.split('-').map(Number);
  $('dateTitle').textContent = `${year}年${month}月`;
  $('dateNext').disabled = year === todayYear && month === todayMonth;
  const startWeekday = new Date(year, month - 1, 1).getDay();
  const days = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) {
    cells.push('<span class="date-cell blank"></span>');
  }
  for (let day = 1; day <= days; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const classes = ['date-cell'];
    if (date === today) classes.push('today');
    if (date === state.date) classes.push('on');
    cells.push(`<button class="${classes.join(' ')}" data-date="${date}"${date > today ? ' disabled' : ''}>${day}</button>`);
  }
  $('dateGrid').innerHTML = cells.join('');
  $('dateGrid').querySelectorAll('[data-date]').forEach((cell) => {
    cell.addEventListener('click', () => {
      state.date = cell.dataset.date;
      closeDatePicker();
      renderHome();
    });
  });
}

async function renderHome() {
  const today = todayStr();
  $('homeDate').textContent = fmtDate(state.date);
  $('homeWeek').textContent = fmtWeekday(state.date) + (state.date === today ? ' · 今天' : '');
  $('nextDay').style.visibility = state.date === today ? 'hidden' : 'visible';
  $('listTitle').textContent = state.date === today ? '今日记录' : fmtDate(state.date) + '记录';

  const meals = await getMealsByDate(state.date);
  const m = state.metrics;
  const total = meals.reduce((sum, item) => sum + num(item.calories), 0);

  $('ringNum').textContent = display(total);
  $('ringTarget').textContent = `目标 ${display(m.target)} kcal`;
  const left = Math.round(m.target - total);
  const leftEl = $('ringLeft');
  leftEl.textContent = left >= 0 ? `还可摄入 ${left.toLocaleString('zh-CN')} kcal` : `已超出 ${Math.abs(left).toLocaleString('zh-CN')} kcal`;
  leftEl.classList.toggle('warn', left < 0);

  const ratio = m.target > 0 ? Math.min(total / m.target, 1) : 0;
  const circumference = 2 * Math.PI * 98;
  $('ringValue').style.strokeDashoffset = String(circumference * (1 - ratio));

  renderMacros(meals);

  const list = $('mealList');
  $('listCount').textContent = meals.length ? `${meals.length} 条` : '';
  if (!meals.length) {
    list.innerHTML = '<p class="empty-tip">还没有记录。拍张照片，或者点右下角手动输入。</p>';
    return;
  }
  list.innerHTML = meals.map((item) => `
    <li class="meal-row" data-id="${item.id}">
      <div class="meal-info">
        <div class="meal-top">
          <span class="meal-name">${escapeHtml(item.name)}</span>
          <span class="meal-kcal">${display(item.calories)} kcal</span>
        </div>
        <div class="meal-meta">${MEAL_LABELS[item.mealType] || ''} · 蛋白 ${Math.round(num(item.protein))} · 脂肪 ${Math.round(num(item.fat))} · 碳水 ${Math.round(num(item.carbs))}</div>
      </div>
      <button class="meal-del" data-del="${item.id}" aria-label="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </li>`).join('');
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); askDeleteMeal(Number(btn.dataset.del)); });
  });
  list.querySelectorAll('.meal-row').forEach((row) => {
    row.addEventListener('click', () => {
      const meal = meals.find((item) => String(item.id) === row.dataset.id);
      if (meal) openEditSheet(meal);
    });
  });
}

function renderMacros(meals) {
  const m = state.metrics;
  const sum = meals.reduce((acc, item) => {
    acc.protein += num(item.protein);
    acc.fat += num(item.fat);
    acc.carbs += num(item.carbs);
    return acc;
  }, { protein: 0, fat: 0, carbs: 0 });
  const rows = [
    ['蛋白质', sum.protein, m.protein],
    ['脂肪', sum.fat, m.fat],
    ['碳水', sum.carbs, m.carbs]
  ];
  $('macros').innerHTML = rows.map(([label, value, goal]) => {
    const pct = goal > 0 ? Math.min(value / goal, 1) * 100 : 0;
    return `<div class="macro-row">
      <span class="macro-name">${label}</span>
      <div class="macro-bar"><div class="macro-fill" style="width:${pct}%"></div></div>
      <span class="macro-num">${Math.round(value)} / ${Math.round(goal)} g</span>
    </div>`;
  }).join('');
}

function askDeleteMeal(id) {
  confirmDialog({
    title: '删除这条记录',
    text: '删除后无法恢复。',
    okText: '删除',
    onOk: async () => {
      await deleteMeal(id);
      await renderHome();
      toast('已删除');
    }
  });
}

async function askWeight() {
  const latest = await getLatestWeight();
  const current = latest ? latest.weight : state.profile.weight;
  openDialog({
    title: '记录体重',
    body: `<input id="dialogInput" class="dialog-input" type="number" inputmode="decimal" value="${current}" placeholder="体重 kg">
           <input id="dialogBodyFat" class="dialog-input" type="number" inputmode="decimal" placeholder="体脂率 %，可不填" style="margin-top:8px">`,
    onOk: async () => {
      const weight = Number($('dialogInput').value);
      if (!Number.isFinite(weight) || weight <= 0) { toast('请输入有效体重'); return false; }
      const bodyFatRaw = $('dialogBodyFat').value.trim();
      const bodyFat = bodyFatRaw ? Number(bodyFatRaw) : null;
      await putWeight({ date: todayStr(), weight: round(weight, 2), bodyFat: bodyFat && Number.isFinite(bodyFat) ? round(bodyFat, 2) : null });
      state.profile.weight = round(weight, 2);
      persistProfile();
      state.metrics = computeMetrics(state.profile);
      toast('已记录');
      if (state.view === 'stats') await renderStats();
      if (state.view === 'settings') renderSettings();
      return true;
    }
  });
}

async function openCamera() {
  switchView('camera');
  $('camStatus').textContent = '';
  setCamBusy(false);
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = $('video');
    video.srcObject = state.stream;
    await video.play();
    video.classList.remove('off');
  } catch (e) {
    $('camStatus').textContent = '相机打不开，可以用相册或手动输入。';
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  $('video').srcObject = null;
  $('video').classList.add('off');
}

function setCamBusy(busy) {
  $('btnShutter').disabled = busy;
  $('btnGallery').disabled = busy;
  $('btnManual').disabled = busy;
}

function captureFrame() {
  const video = $('video');
  if (!video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  const width = 1280;
  const scale = width / video.videoWidth;
  canvas.width = width;
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

function compressImage(source, maxWidth = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = Math.min(maxWidth, img.width);
      const scale = width / img.width;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = source;
  });
}

async function onShutter() {
  const dataUrl = captureFrame();
  if (!dataUrl) { toast('画面还没准备好'); return; }
  await runRecognize(dataUrl);
}

async function onPickPhoto() {
  const file = $('fileInput').files && $('fileInput').files[0];
  $('fileInput').value = '';
  if (!file) return;
  if (!state.stream && state.view !== 'camera') switchView('camera');
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = await compressImage(String(reader.result));
      await runRecognize(dataUrl);
    } catch (e) {
      toast(e.message || '图片处理失败');
    }
  };
  reader.readAsDataURL(file);
}

async function runRecognize(dataUrl) {
  if (!state.profile.apiKey) {
    openSheet('manual');
    $('sheetNote').textContent = '还没填 API Key，先手动输入这一条。';
    $('sheetNote').classList.remove('hidden');
    return;
  }
  $('camStatus').textContent = '正在识别…';
  setCamBusy(true);
  try {
    const result = await recognize(dataUrl);
    openSheet('ai', result);
  } catch (e) {
    openSheet('manual');
    $('sheetNote').textContent = '识别失败：' + (e.message || '网络错误') + '。可以手动填写。';
    $('sheetNote').classList.remove('hidden');
    if (e.raw) {
      $('sheetBody').insertAdjacentHTML('afterbegin', `<div class="raw-text">${escapeHtml(e.raw)}</div>`);
    }
  } finally {
    $('camStatus').textContent = '';
    setCamBusy(false);
  }
}

async function recognize(dataUrl) {
  const body = {
    model: MODEL,
    temperature: 0.1,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: RECOGNIZE_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
      ]
    }]
  };
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.profile.apiKey },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`接口返回 ${res.status}`);
    err.raw = text.slice(0, 1200);
    throw err;
  }
  let payload;
  try { payload = JSON.parse(text); } catch (e) { payload = null; }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? String(payload.choices[0].message.content || '') : text;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    const err = new Error('返回内容不是 JSON');
    err.raw = content.slice(0, 1200);
    throw err;
  }
  let data;
  try { data = JSON.parse(match[0]); } catch (e) {
    const err = new Error('JSON 解析失败');
    err.raw = content.slice(0, 1200);
    throw err;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    items: items.map((item) => ({
      name: String(item.name || '未命名'),
      grams: Math.max(0, num(item.grams)),
      calories: Math.max(0, num(item.calories)),
      protein: Math.max(0, num(item.protein)),
      fat: Math.max(0, num(item.fat)),
      carbs: Math.max(0, num(item.carbs))
    })),
    confidence: ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'low',
    note: typeof data.note === 'string' ? data.note : ''
  };
}

function makeSheetItem(raw) {
  return {
    id: 'r' + Math.random().toString(36).slice(2, 9),
    name: raw.name || '',
    grams: raw.grams || 0,
    calories: raw.calories || 0,
    protein: raw.protein || 0,
    fat: raw.fat || 0,
    carbs: raw.carbs || 0,
    baseGrams: raw.grams || 0,
    baseCalories: raw.calories || 0,
    baseProtein: raw.protein || 0,
    baseFat: raw.fat || 0,
    baseCarbs: raw.carbs || 0
  };
}

function openSheet(mode, result) {
  const sheet = state.sheet;
  sheet.mode = mode;
  sheet.editingId = null;
  sheet.date = state.date;
  sheet.mealType = defaultMealType();
  sheet.raw = '';
  sheet.note = '';
  if (mode === 'ai' && result) {
    sheet.items = result.items.length ? result.items.map(makeSheetItem) : [makeSheetItem({})];
    sheet.note = result.items.length === 0 ? '没有识别到食物，可以手动补。' : (result.confidence === 'low' ? '估算可能偏差，请核对。' : '');
    if (result.note && result.confidence === 'low') sheet.note = `估算可能偏差，请核对。${result.note}`;
  } else {
    sheet.items = [makeSheetItem({})];
  }
  $('sheetTitle').textContent = mode === 'ai' ? '识别结果' : (mode === 'edit' ? '修改记录' : '手动输入');
  $('sheetExtra').textContent = '添加条目';
  $('sheetExtra').classList.remove('hidden');
  $('sheet').classList.remove('hidden');
  $('sheet').classList.add('closing');
  requestAnimationFrame(() => requestAnimationFrame(() => $('sheet').classList.remove('closing')));
  renderSheet();
}

function openEditSheet(meal) {
  const sheet = state.sheet;
  sheet.mode = 'edit';
  sheet.editingId = meal.id;
  sheet.date = meal.date;
  sheet.mealType = meal.mealType || 'lunch';
  sheet.items = [makeSheetItem(meal)];
  sheet.note = '';
  $('sheetTitle').textContent = '修改记录';
  $('sheetExtra').classList.add('hidden');
  $('sheet').classList.remove('hidden');
  $('sheet').classList.add('closing');
  requestAnimationFrame(() => requestAnimationFrame(() => $('sheet').classList.remove('closing')));
  renderSheet();
}

function closeSheet() {
  $('sheet').classList.add('closing');
  setTimeout(() => {
    $('sheet').classList.add('hidden');
    $('sheet').classList.remove('closing');
    if (state.view === 'camera') {
      stopCamera();
      switchView('home');
    }
    renderHome();
  }, 240);
}

function defaultMealType() {
  const hour = new Date().getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 20) return 'dinner';
  return 'snack';
}

function renderSheet() {
  const sheet = state.sheet;
  const note = $('sheetNote');
  if (sheet.note) {
    note.textContent = sheet.note;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
  const body = $('sheetBody');
  body.innerHTML = '';
  if (sheet.raw) {
    body.insertAdjacentHTML('beforeend', `<div class="raw-text">${escapeHtml(sheet.raw)}</div>`);
  }
  sheet.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="item-line">
        <input class="item-name" data-f="name" type="text" value="${escapeHtml(item.name)}" placeholder="食物名">
        <input class="item-kcal" data-f="calories" type="number" inputmode="decimal" value="${item.calories}" placeholder="热量">
        <span class="item-kcal-unit">kcal</span>
        <button class="item-del" data-del aria-label="删除条目">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="item-meta">
        <span>克数</span>
        <input class="item-grams" data-f="grams" type="number" inputmode="decimal" value="${item.grams}">
        <span>g</span>
      </div>
      <div class="item-macro-edit">
        <label>蛋白<input class="item-num" data-f="protein" type="number" inputmode="decimal" value="${item.protein}"><span>g</span></label>
        <label>脂肪<input class="item-num" data-f="fat" type="number" inputmode="decimal" value="${item.fat}"><span>g</span></label>
        <label>碳水<input class="item-num" data-f="carbs" type="number" inputmode="decimal" value="${item.carbs}"><span>g</span></label>
      </div>`;
    row.querySelector('[data-f="name"]').addEventListener('input', (e) => { item.name = e.target.value; });
    row.querySelector('[data-f="calories"]').addEventListener('input', (e) => { item.calories = Math.max(0, num(e.target.value)); });
    row.querySelector('[data-f="grams"]').addEventListener('input', (e) => {
      item.grams = Math.max(0, num(e.target.value));
      applyRatio(item);
      row.querySelector('[data-f="calories"]').value = item.calories;
      row.querySelector('[data-f="protein"]').value = item.protein;
      row.querySelector('[data-f="fat"]').value = item.fat;
      row.querySelector('[data-f="carbs"]').value = item.carbs;
    });
    row.querySelector('[data-f="protein"]').addEventListener('input', (e) => { item.protein = Math.max(0, num(e.target.value)); });
    row.querySelector('[data-f="fat"]').addEventListener('input', (e) => { item.fat = Math.max(0, num(e.target.value)); });
    row.querySelector('[data-f="carbs"]').addEventListener('input', (e) => { item.carbs = Math.max(0, num(e.target.value)); });
    row.querySelector('[data-del]').addEventListener('click', () => {
      if (sheet.items.length <= 1) { toast('至少保留一条'); return; }
      sheet.items.splice(index, 1);
      renderSheet();
    });
    body.appendChild(row);
  });

  const typeRow = document.createElement('div');
  typeRow.className = 'mealtype-row';
  MEAL_TYPES.forEach(([key, label]) => {
    const chip = document.createElement('button');
    chip.className = 'mealtype-chip ' + (sheet.mealType === key ? 'on' : '');
    chip.textContent = label;
    chip.addEventListener('click', () => { sheet.mealType = key; renderSheet(); });
    typeRow.appendChild(chip);
  });
  body.appendChild(typeRow);
}

function applyRatio(item) {
  if (!item.baseGrams) return;
  const ratio = item.grams / item.baseGrams;
  item.calories = Math.round(item.baseCalories * ratio);
  item.protein = round(item.baseProtein * ratio, 1);
  item.fat = round(item.baseFat * ratio, 1);
  item.carbs = round(item.baseCarbs * ratio, 1);
}

function addSheetItem() {
  state.sheet.items.push(makeSheetItem({}));
  renderSheet();
}

async function saveSheet() {
  const sheet = state.sheet;
  const valid = sheet.items.filter((item) => item.name.trim() && num(item.calories) > 0);
  if (!valid.length) { toast('请填名称和热量'); return; }
  const timestamp = Date.now();
  const targetDate = sheet.date || state.date;
  if (sheet.mode === 'edit' && sheet.editingId != null) {
    const meal = valid[0];
    await putMeal({
      id: sheet.editingId,
      date: targetDate,
      name: meal.name.trim(),
      grams: round(num(meal.grams), 2),
      calories: round(num(meal.calories), 2),
      protein: round(num(meal.protein), 2),
      fat: round(num(meal.fat), 2),
      carbs: round(num(meal.carbs), 2),
      mealType: sheet.mealType,
      timestamp
    });
  } else {
    for (let i = 0; i < valid.length; i += 1) {
      const item = valid[i];
      await addMeal({
        date: targetDate,
        name: item.name.trim(),
        grams: round(num(item.grams), 2),
        calories: round(num(item.calories), 2),
        protein: round(num(item.protein), 2),
        fat: round(num(item.fat), 2),
        carbs: round(num(item.carbs), 2),
        mealType: sheet.mealType,
        timestamp: timestamp + i
      });
    }
  }
  closeSheet();
  toast('已保存');
}

async function openStats() {
  switchView('stats');
  await renderStats();
}

async function renderStats() {
  const end = todayStr();
  const start = shiftDate(end, -6);
  const meals = await getMealsRange(start, end);
  const weightStart = shiftDate(end, -29);
  const weights = await getWeightsRange(weightStart, end);
  renderCalChart(meals, start);
  renderWeightChart(weights, weightStart, end);
  renderSummary(meals, weights, start, end);
}

function renderCalChart(meals, start) {
  const box = $('calChart');
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = shiftDate(start, i);
    days.push({ date, total: 0, protein: 0 });
  }
  meals.forEach((item) => {
    const day = days.find((d) => d.date === item.date);
    if (day) { day.total += num(item.calories); day.protein += num(item.protein); }
  });
  const target = state.metrics.target;
  const maxVal = Math.max(target, ...days.map((d) => d.total), 100);
  if (!days.some((d) => d.total > 0)) {
    box.innerHTML = '<p class="chart-empty">这七天还没有记录。</p>';
    return;
  }
  const W = 340, H = 190, PT = 14, PB = 26, PH = H - PT - PB;
  const barW = 24;
  const slot = W / 7;
  const y = (value) => PT + PH * (1 - value / maxVal);
  const targetY = y(target);
  const bars = days.map((day, i) => {
    const x = slot * i + (slot - barW) / 2;
    const h = Math.max(0, PH * (day.total / maxVal));
    const top = PT + PH - h;
    return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="3" fill="#4f46e5" ${day.total > 0 ? '' : 'opacity="0"'}/>`;
  }).join('');
  const labels = days.map((day, i) => {
    const cx = slot * i + slot / 2;
    return `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#8a8f99">${Number(day.date.split('-')[2])}</text>`;
  }).join('');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近七天热量柱状图">
    <line x1="0" y1="${targetY.toFixed(1)}" x2="${W}" y2="${targetY.toFixed(1)}" stroke="#c4c8d0" stroke-width="1" stroke-dasharray="4 4"/>
    ${bars}${labels}
  </svg>
  <div class="chart-legend"><span><i class="legend-dash"></i>目标 ${display(target)} kcal</span></div>`;
}

function rollingAverage(weights, days = 7) {
  return weights.map((row) => {
    const from = shiftDate(row.date, -(days - 1));
    const slice = weights.filter((w) => w.date >= from && w.date <= row.date);
    const sum = slice.reduce((acc, w) => acc + num(w.weight), 0);
    return { date: row.date, value: sum / slice.length };
  });
}

function weightTrend(weights) {
  const today = todayStr();
  const recent = weights.filter((w) => w.date >= shiftDate(today, -13));
  const mid = shiftDate(today, -6);
  const firstHalf = recent.filter((w) => w.date < mid);
  const secondHalf = recent.filter((w) => w.date >= mid);
  if (firstHalf.length < 2 || secondHalf.length < 2) return '';
  const avg = (rows) => rows.reduce((acc, r) => acc + num(r.weight), 0) / rows.length;
  const diff = avg(secondHalf) - avg(firstHalf);
  if (Math.abs(diff) < 0.2) return '最近两周体重均值几乎没变，可以把每日缺口再放小 100 kcal。';
  if (diff < -0.8) return `最近七天均值比前七天低 ${Math.abs(diff).toFixed(1)} kg，偏快，注意蛋白和脂肪别缺。`;
  return '';
}

function renderWeightChart(weights, start, end) {
  const box = $('weightChart');
  if (!weights.length) {
    box.innerHTML = '<p class="chart-empty">还没有体重记录。</p>';
    return;
  }
  const avgRows = rollingAverage(weights);
  const all = weights.map((w) => num(w.weight)).concat(avgRows.map((a) => a.value));
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = Math.max(max - min, 1);
  const low = min - span * 0.2;
  const high = max + span * 0.2;
  const W = 340, H = 180, PL = 34, PR = 8, PT = 12, PB = 24;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;
  const totalDays = 30;
  const x = (date) => {
    const days = Math.round((new Date(date + 'T00:00:00') - new Date(start + 'T00:00:00')) / 86400000);
    return PL + chartW * (days / (totalDays - 1));
  };
  const y = (value) => PT + chartH * (1 - (value - low) / (high - low));
  const rawPoints = weights.map((w) => `${x(w.date).toFixed(1)},${y(num(w.weight)).toFixed(1)}`).join(' ');
  const avgPoints = avgRows.map((a) => `${x(a.date).toFixed(1)},${y(a.value).toFixed(1)}`).join(' ');
  const dots = weights.map((w) => `<circle cx="${x(w.date).toFixed(1)}" cy="${y(num(w.weight)).toFixed(1)}" r="2" fill="#c4c8d0"/>`).join('');
  const lowLabel = max - min < 0.05 ? '' : `<text x="${PL - 6}" y="${(y(min) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#8a8f99">${min.toFixed(1)}</text>`;
  const trend = weightTrend(weights);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="体重折线图">
    <text x="${PL - 6}" y="${(y(max) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#8a8f99">${max.toFixed(1)}</text>
    ${lowLabel}
    <text x="${PL}" y="${H - 6}" font-size="10" fill="#8a8f99">${fmtShort(start)}</text>
    <text x="${W - PR}" y="${H - 6}" text-anchor="end" font-size="10" fill="#8a8f99">${fmtShort(end)}</text>
    <polyline points="${rawPoints}" fill="none" stroke="#c4c8d0" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <polyline points="${avgPoints}" fill="none" stroke="#4f46e5" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>
  <div class="chart-legend"><span><i class="legend-line light"></i>单次体重</span><span><i class="legend-line accent"></i>7 日均值</span></div>
  ${trend ? `<p class="hint">${trend}</p>` : ''}`;
}

function renderSummary(meals, weights, start, end) {
  const box = $('weekSummary');
  if (!meals.length && !weights.length) {
    box.innerHTML = '<p class="chart-empty">攒几天数据再看。</p>';
    return;
  }
  const total = meals.reduce((sum, item) => sum + num(item.calories), 0);
  const protein = meals.reduce((sum, item) => sum + num(item.protein), 0);
  const avgCal = Math.round(total / 7);
  const avgProtein = Math.round(protein / 7);
  let change = '—';
  if (weights.length >= 2) {
    const delta = num(weights[weights.length - 1].weight) - num(weights[0].weight);
    change = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg`;
  } else if (weights.length === 1) {
    change = '数据不足';
  }
  box.innerHTML = `
    <div class="summary-row"><span class="k">日均摄入</span><span class="v">${display(avgCal)} kcal</span></div>
    <div class="summary-row"><span class="k">日均蛋白质</span><span class="v">${display(avgProtein)} g</span></div>
    <div class="summary-row"><span class="k">体重变化</span><span class="v">${change}</span></div>`;
}

function renderSettings() {
  const p = state.profile;
  const m = state.metrics;
  const persona = p.persona;
  const personaHint = persona
    ? `按你的描述，每天大约消耗 ${display(persona.tdee)} kcal${persona.note ? '。依据：' + escapeHtml(persona.note) : ''}`
    : '还没估过。写一段日常，让 AI 估一下每天大约消耗多少。';
  const box = $('settingsMain');
  box.innerHTML = `
    <section class="group">
      <h2 class="group-title">身体信息</h2>
      <div class="rows">
        ${settingRow('height', '身高', `${p.height} cm`)}
        ${settingRow('weight', '体重', `${p.weight} kg`)}
        ${settingRow('age', '年龄', `${p.age} 岁`)}
        ${settingRow('sex', '性别', SEX_LABELS[p.sex])}
        ${settingRow('activity', '活动水平', ACTIVITY_LABELS[p.activity])}
        ${settingRow('goal', '目标', GOAL_LABELS[p.goal])}
      </div>
    </section>
    <section class="group">
      <h2 class="group-title">人物画像</h2>
      <textarea id="personaText" class="text-area" rows="3" placeholder="例如：大学生，每天上下课步行 30 分钟，每周打两次球，其余时间坐着">${escapeHtml(persona ? persona.text : '')}</textarea>
      <div class="persona-actions">
        <button id="personaRun" class="primary-btn small">AI 估算</button>
        <button id="personaClear" class="text-btn">清除画像</button>
      </div>
      <p id="personaState" class="hint">${personaHint}</p>
      <p class="hint">描述只保存在本机，点 AI 估算时会连同身体信息一起发给 DeepSeek。</p>
    </section>
    <section class="group">
      <h2 class="group-title">摄入参数</h2>
      <div class="rows">
        ${settingRow('deficit', '每日热量缺口', p.goal === 'cut' ? `${p.deficit} kcal` : '仅减脂生效')}
        ${settingRow('proteinFactor', '蛋白质系数', `${p.proteinFactor} g/kg`)}
        ${settingRow('fatRatio', '脂肪占比', `${Math.round(p.fatRatio * 100)}%`)}
      </div>
      <p class="hint">减脂时从每天的总消耗里减去缺口，剩下的就是一天该吃的量；维持按总消耗吃，增肌比总消耗多一点。蛋白质按体重算，脂肪按热量比例但不低于体重下限，剩下给碳水。</p>
    </section>
    <section class="group">
      <h2 class="group-title">计算结果</h2>
      <div class="rows">
        ${staticRow('BMI', m.bmi.toFixed(1))}
        ${staticRow('基础代谢', `${display(m.bmr)} kcal`)}
        ${staticRow('每日总消耗', `${display(m.tdee)} kcal${m.personaActive ? ' · AI 估算' : ''}`)}
        ${staticRow('每日目标热量', `${display(m.target)} kcal`)}
        ${staticRow('预计每日缺口', m.gap >= 0 ? `${display(m.gap)} kcal · ${Math.round(m.gapRatio * 100)}%` : `盈余 ${display(-m.gap)} kcal`)}
        ${staticRow('蛋白质目标', `${Math.round(m.protein)} g`)}
        ${staticRow('脂肪目标', `${Math.round(m.fat)} g`)}
        ${staticRow('碳水目标', `${Math.round(m.carbs)} g`)}
      </div>
      ${m.clamped ? `<p class="hint">目标热量已触及安全下限，实际缺口约 ${display(m.gap)} kcal。</p>` : ''}
      ${m.small ? '<p class="hint">缺口不到总消耗的 15%，减脂会比较慢，常见区间是 15%–20%。</p>' : ''}
      ${m.heavy ? '<p class="hint">缺口超过总消耗的四分之一，容易掉肌肉，建议收小一些。</p>' : ''}
      ${m.fatGuard === -1 ? `<p class="hint">脂肪按 0.6 g/kg 下限算到 ${Math.round(m.fat)} g，再低容易影响激素和恢复。</p>` : ''}
      ${m.fatGuard === 1 ? `<p class="hint">脂肪按 1.0 g/kg 上限算到 ${Math.round(m.fat)} g，多余热量给了碳水。</p>` : ''}
      ${m.carbsPerKg < 2 ? `<p class="hint">碳水约 ${m.carbsPerKg.toFixed(1)} g/kg，低于 2 g/kg，训练日可能没劲。</p>` : ''}
    </section>
    <section class="group">
      <h2 class="group-title">API 配置</h2>
      <div class="api-row">
        <input id="apiKeyInput" class="text-input" type="password" placeholder="填写 API Key" value="${escapeHtml(p.apiKey)}">
        <button id="apiCheck" class="primary-btn small">校验</button>
      </div>
      <p class="hint">Key 只保存在本机，不会上传。</p>
      <p id="apiState" class="hint"></p>
    </section>
    <section class="group">
      <h2 class="group-title">数据管理</h2>
      <div class="manage-rows">
        <button class="manage-row" id="exportBtn"><span class="k">导出数据</span><span class="v">JSON${chevron()}</span></button>
        <button class="manage-row" id="importBtn"><span class="k">导入数据</span><span class="v">选择文件${chevron()}</span></button>
        <button class="manage-row" id="clearBtn"><span class="k">清空数据</span><span class="v danger">不可恢复</span></button>
      </div>
    </section>`;

  box.querySelectorAll('[data-field]').forEach((btn) => {
    btn.addEventListener('click', () => editField(btn.dataset.field, p, () => {
      persistProfile();
      state.metrics = computeMetrics(p);
      renderSettings();
      renderHome();
    }));
  });

  const apiInput = $('apiKeyInput');
  apiInput.addEventListener('change', () => {
    p.apiKey = apiInput.value.trim();
    persistProfile();
    toast('已保存');
  });
  $('apiCheck').addEventListener('click', async () => {
    const key = apiInput.value.trim();
    if (!key) { $('apiState').textContent = '先填写 Key。'; return; }
    p.apiKey = key;
    persistProfile();
    $('apiState').textContent = '正在校验…';
    try {
      const ok = await verifyKey(key);
      $('apiState').textContent = ok ? '校验通过，可以使用。' : '校验失败，检查 Key 是否有效。';
      $('apiState').classList.toggle('accent', ok);
    } catch (e) {
      $('apiState').textContent = '校验失败：' + (e.message || '网络错误');
      $('apiState').classList.remove('accent');
    }
  });
  $('personaRun').addEventListener('click', runPersona);
  $('personaClear').addEventListener('click', clearPersona);
  $('exportBtn').addEventListener('click', exportData);
  $('importBtn').addEventListener('click', () => $('importInput').click());
  $('clearBtn').addEventListener('click', askClear);
}

function settingRow(key, label, value) {
  return `<button class="row" data-field="${key}"><span class="k">${label}</span><span class="v">${escapeHtml(value)}${chevron()}</span></button>`;
}

function staticRow(label, value) {
  return `<div class="row static"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

async function runPersona() {
  const text = $('personaText').value.trim();
  if (!text) { toast('先写一句日常描述'); return; }
  if (!state.profile.apiKey) { toast('先在上面填 API Key'); return; }
  const button = $('personaRun');
  button.disabled = true;
  $('personaState').textContent = '正在估算…';
  try {
    const persona = await estimatePersona(text);
    state.profile.persona = persona;
    persistProfile();
    state.metrics = computeMetrics(state.profile);
    renderSettings();
    renderHome();
    toast('已应用画像');
  } catch (e) {
    $('personaState').textContent = '估算失败：' + (e.message || '网络错误');
  } finally {
    if ($('personaRun')) $('personaRun').disabled = false;
  }
}

function clearPersona() {
  if (!state.profile.persona) { toast('当前没有画像'); return; }
  state.profile.persona = null;
  persistProfile();
  state.metrics = computeMetrics(state.profile);
  renderSettings();
  renderHome();
  toast('已恢复按活动系数计算');
}

async function estimatePersona(text) {
  const p = state.profile;
  const prompt = `你是运动营养师。根据下面的信息估算这个人每天的日常总热量消耗，单位千卡。
身高 ${p.height} 厘米，体重 ${p.weight} 公斤，年龄 ${p.age} 岁，性别${SEX_LABELS[p.sex]}，目前选择的活动水平是${ACTIVITY_LABELS[p.activity]}。
日常描述：${text}
只返回 JSON，不要其他文字，不要 markdown 代码块：{"tdee":数字,"activity":"sedentary|light|moderate|high","note":"一句话依据"}`;
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.apiKey },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: 'user', content: prompt }] })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`接口返回 ${res.status}`);
  let payload = null;
  try { payload = JSON.parse(raw); } catch (e) { payload = null; }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? String(payload.choices[0].message.content || '') : raw;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('返回内容不是 JSON');
  let data;
  try { data = JSON.parse(match[0]); } catch (e) { throw new Error('JSON 解析失败'); }
  const tdee = Math.round(num(data.tdee));
  if (!Number.isFinite(tdee) || tdee < 1000 || tdee > 6000) throw new Error('估算值超出合理范围');
  if (state.metrics && tdee < state.metrics.bmr * 1.05) throw new Error('估算值低于基础代谢');
  return {
    text,
    tdee,
    activity: ACTIVITY[data.activity] ? data.activity : null,
    note: String(data.note || '').slice(0, 120)
  };
}

async function verifyKey(key) {
  const res = await fetch(MODELS_URL, {
    headers: { Authorization: 'Bearer ' + key }
  });
  return res.ok;
}

async function exportData() {
  try {
    const data = await exportAll();
    data.profile = {
      height: state.profile.height, weight: state.profile.weight, age: state.profile.age,
      sex: state.profile.sex, activity: state.profile.activity, goal: state.profile.goal,
      deficit: state.profile.deficit, proteinFactor: state.profile.proteinFactor,
      fatRatio: state.profile.fatRatio, persona: state.profile.persona
    };
    const json = JSON.stringify(data, null, 2);
    const name = `热量记录-${todayStr()}.json`;
    if (isNative) {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content: json })
      });
      const result = await res.json();
      toast(result.ok ? '已导出到 ' + result.path : '导出失败');
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出');
  } catch (e) {
    toast('导出失败');
  }
}

function onPickImport() {
  const file = $('importInput').files && $('importInput').files[0];
  $('importInput').value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(String(reader.result)); } catch (e) { toast('文件不是有效的 JSON'); return; }
    if (!data || data.app !== 'calorieApp' || !Array.isArray(data.meals)) { toast('不是本应用的数据文件'); return; }
    confirmDialog({
      title: '导入数据',
      text: '导入会覆盖当前全部记录，确定继续？',
      okText: '导入',
      onOk: async () => {
        await importAll(data);
        if (data.profile) {
          state.profile = { ...state.profile, ...data.profile };
          const persona = data.profile.persona;
          if (persona && Number.isFinite(Number(persona.tdee)) && Number(persona.tdee) > 0) {
            state.profile.persona = {
              text: String(persona.text || ''),
              tdee: Number(persona.tdee),
              activity: ACTIVITY[persona.activity] ? persona.activity : null,
              note: String(persona.note || '')
            };
          } else {
            state.profile.persona = null;
          }
          persistProfile();
          state.metrics = computeMetrics(state.profile);
        }
        renderSettings();
        toast('已导入');
      }
    });
  };
  reader.readAsText(file);
}

function askClear() {
  confirmDialog({
    title: '清空全部数据',
    text: '所有记录和体重都会被删除，无法恢复。建议先导出备份。',
    okText: '清空',
    onOk: async () => {
      await clearAll();
      await renderHome();
      toast('已清空');
    }
  });
}

let started = false;

function startApp() {
  if (started) return;
  started = true;
  init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
