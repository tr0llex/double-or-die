/**
 * `npm run balance` — Monte-Carlo прогон ограничителей ECONOMY §13 / DIFFICULTY
 * §10 полной симуляцией (SIMULATION.md §8). Это ГЕЙТ: красный ограничитель
 * валит команду ненулевым кодом, как валит тест (задача 2.3).
 *
 * Модуль только СОБИРАЕТ `Sample[]` (полной симуляцией, тик за тиком) и отдаёт
 * его `computeConstraints` из `constraints.ts` — самого расчёта порогов здесь
 * нет и не должно быть, он уже написан и не дублируется.
 *
 * Состав в 0.4.0 — только N=1: кооп-составов ещё нет (ROADMAP §0.4.0,
 * ECONOMY §13 «G11/G15/G16 — считаются с 0.5.0»). Прогонять `--players 2..4`
 * здесь нечем и незачем: составы приедут вместе с задачей 0.5.0.
 *
 * ДВЕ ПОПУЛЯЦИИ, а не одна — и это не разделение ради равномерности отчёта.
 * Ограничители делятся на два рода:
 *
 *   — те, что фильтруют выборку по конкретному профилю (G1/G2 — стратегия
 *     `none`, G3 — `stack`/`chips`, G4 — `veteran`/`master`, G5 — `median`+
 *     `stack`, G8/D3 — `median`), — им подходит любая выборка, где есть нужный
 *     профиль в достаточном числе;
 *   — те, что считаются по ВСЕЙ выборке без фильтра (G6, G7, G10, G12, G14,
 *     D2, D5, D6, D7, D9), — им нужна выборка, представляющая РЕАЛЬНОЕ
 *     распределение игроков, а не равномерную смесь шестнадцати профилей.
 *
 * Профиль `mixed` (SIMULATION §3) и есть то самое реальное распределение:
 * гипотеза об аудитории с весами по навыку и стратегии. Он и есть основная
 * популяция. Но `mixed` СТРУКТУРНО не включает стратегию `none` (SIMULATION
 * §3: «заметная доля такого профиля валила бы ограничитель составом смеси, а
 * не балансом игры») — значит G1 и G2, которым эта стратегия нужна для
 * фильтра, из одного `mixed` не посчитать никогда, при любом объёме выборки.
 * Поэтому вторая, маленькая популяция — прогон `novice:none` (SIMULATION §3
 * называет его по имени: «Трус прогоняется отдельным `--bot novice:none`»),
 * добавленный к общему пулу. G6 после этого объединения не ломается составом
 * пула: см. правку `g6` в `constraints.ts` — фильтр там исключает стратегию
 * `none` явно, а не полагается на то, что её никто не намешает.
 */

import {
  BETS,
  Curse,
  DoorType,
  EntityFlag,
  MAX_ENEMIES,
  MAX_UPGRADE_SLOTS,
  Meta,
  RunPhase,
  TICK_HZ,
  checkInvariants,
  createState,
  spawnPlayers,
  step,
  toFloat,
  type SimState,
} from '@dod/sim';
import { makeBot, PROFILE_NAMES, type BotName } from './bots';
import { Observer } from './observe';
import { checkSafety } from './safety';
import {
  calibrateBets,
  computeConstraints,
  formatCalibration,
  formatReport,
  type BetCatalogEntry,
  type BossFight,
  type Sample,
  type UpgradeAcquisition,
} from './constraints';

/**
 * Потолок тиков на один забег — тот же аргумент, что у `--timing`
 * (`cli.ts`, `TIMING_TICK_CAP`): вдвое больше верхней границы коридора
 * «12–18 минут» (ROADMAP §0.4.0), чтобы медленный, но живой забег не
 * обрывался раньше своих итогов и не путался с зависшим. Число не переиспользуется
 * напрямую из `cli.ts` — там оно не экспортировано, а заводить экспорт ради
 * одной константы, читаемой в одном месте, менять интерфейс модуля не стоит.
 */
export const BALANCE_TICK_CAP = 30 * 60 * TICK_HZ;

/**
 * Добавка «осторожных» к каждому балансному прогону: стратегия `none` по той
 * же смеси навыков, что и `mixed`.
 *
 * ДВА исправления против прежних «30 × novice:none».
 *
 * Первое — навык. «Осторожный» из ECONOMY §6 это СТРАТЕГИЯ («ноль ставок»), а
 * не навык, и прогонять её одним новичком значит мерить G1 в самом жёстком из
 * возможных прочтений: порог «первый этаж проходят ≥90%» назначался игроку,
 * который не ставит, а не игроку, который вдобавок хуже всех стреляет.
 * Скилловый состав берётся тот же, что у `mixed` (SIMULATION §3), — это и есть
 * гипотеза об аудитории, и осторожные из неё не выпадают.
 *
 * Второе — объём. При тридцати прогонах половина доверительного интервала доли
 * составляет 5.5 процентного пункта: три забега решают вердикт девяностого
 * порога. Сто двадцать сжимают её до 2.7 — порог перестаёт зависеть от того,
 * как лягут единичные сиды, а стоит это секунды.
 */
const NONE_SUPPLEMENT_RUNS = 120;

/**
 * Смесь навыков для добавки — ровно таблица SIMULATION §3 (`mixed`), только
 * без её оси стратегий: стратегия здесь одна и заданная, `none`.
 */
const NONE_SUPPLEMENT_SKILLS: readonly BotName[] = [
  'novice:none',
  'median:none',
  'veteran:none',
  'master:none',
];
const NONE_SUPPLEMENT_WEIGHTS = [25, 40, 25, 10] as const;

/** Какой навык достаётся `i`-му прогону добавки: раскладка по весам, без RNG. */
function supplementBot(i: number): BotName {
  const total = NONE_SUPPLEMENT_WEIGHTS.reduce((a, b) => a + b, 0);
  const pos = ((i * total) / NONE_SUPPLEMENT_RUNS) % total;
  let acc = 0;
  for (let k = 0; k < NONE_SUPPLEMENT_SKILLS.length; k++) {
    acc += NONE_SUPPLEMENT_WEIGHTS[k];
    if (pos < acc) return NONE_SUPPLEMENT_SKILLS[k];
  }
  return NONE_SUPPLEMENT_SKILLS[NONE_SUPPLEMENT_SKILLS.length - 1];
}

/** Каталог множителей пари для G5 — тот же вид, что просит `computeConstraints`. */
export const betCatalog: readonly BetCatalogEntry[] = BETS.map((b) => ({
  id: b.id,
  multiplier: toFloat(b.multiplier),
}));

/** Жив ли хоть один игрок за столом прямо сейчас. */
function anyAlive(s: SimState): boolean {
  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) !== 0) return true;
  }
  return false;
}

/**
 * Один полный забег: от `spawnPlayers` до `RunPhase.Summary` или до потолка
 * тиков — собирает всё, что нужно `Sample` (см. шапку `constraints.ts`).
 *
 * Устроен параллельно `runToSummary` в `cli.ts`, но не переиспользует её:
 * той функции хватает исхода и хеша, этой — полного разбора забега
 * (`Observer`, апгрейды, бои с боссами, долг, безопасная точка, потолок
 * врагов на экране). Слить их значило бы тащить в лёгкий `--timing` пять
 * полей, которые ему не нужны, или сюда — параметр «нужен ли Observer»,
 * который здесь нужен всегда: без него не посчитать ни одного G/D.
 */
export function runBalanceSample(seed: number, players: number, bot: BotName): Sample {
  const s = createState(seed, players);
  spawnPlayers(s);
  const b = makeBot(bot, seed, players);
  const observer = new Observer(s);

  const upgrades: UpgradeAcquisition[] = [];
  const bossFights: BossFight[] = [];

  // Снимок слотов апгрейдов «до» — покупка видна как переход 0 → ненулевое,
  // тем же приёмом, что карты в `cli.ts` (`cardWas`).
  const prevUpgrades = new Int32Array(s.pUpgrades.length);
  prevUpgrades.set(s.pUpgrades);

  let debtSeen = false;
  let safetyBroken = false;
  let maxEnemiesOnScreen = 0;

  let bossActive = false;
  let bossStart = 0;
  let bossFloor = 1;

  let t = 0;
  for (; t < BALANCE_TICK_CAP; t++) {
    observer.before(s);
    step(s, b.inputs(s));
    observer.after(s);
    checkInvariants(s);

    // D4 — каждый тик, как и `--safety`: срыв длится один кадр, реже не поймать.
    if (!safetyBroken && checkSafety(s) !== null) safetyBroken = true;

    // D9 — максимум одновременно живых врагов за весь забег.
    let onScreen = 0;
    for (let e = 0; e < MAX_ENEMIES; e++) if (s.eActive[e]) onScreen++;
    if (onScreen > maxEnemiesOnScreen) maxEnemiesOnScreen = onScreen;

    // G7 — единственный источник проклятия это долг (ECONOMY §10, комментарий
    // `Sample.debtSeen` в constraints.ts).
    if (s.meta[Meta.Curse] !== Curse.None) debtSeen = true;

    // G2/G3 — апгрейд получен: слот 0 → ненулевое. Платный или Дар решает
    // `RoomType` в момент получения: Дар единственный ставит его в `Gift`
    // (upgrades.ts, `openGift`), лавка оставляет тип двери как есть.
    for (let i = 0; i < s.pUpgrades.length; i++) {
      if (s.pUpgrades[i] !== 0 && prevUpgrades[i] === 0) {
        upgrades.push({
          player: Math.floor(i / MAX_UPGRADE_SLOTS),
          floor: s.meta[Meta.Floor],
          paid: s.meta[Meta.RoomType] !== DoorType.Gift,
        });
      }
    }
    prevUpgrades.set(s.pUpgrades);

    // D7 — длительность каждого боя с боссом, по переходу фазы.
    const inBoss = s.meta[Meta.Phase] === RunPhase.Boss;
    if (inBoss && !bossActive) {
      bossActive = true;
      bossStart = t;
      bossFloor = s.meta[Meta.Floor];
    } else if (!inBoss && bossActive) {
      bossActive = false;
      // Бой засчитывается доигранным, только если после него игрок ЖИВ:
      // фаза босса кончается и смертью тоже, а такой замер меряет не босса.
      bossFights.push({ floor: bossFloor, ticks: t - bossStart, won: anyAlive(s) });
    }

    if (s.meta[Meta.Phase] === RunPhase.Summary) break;
  }

  const outcome: Sample['outcome'] =
    s.meta[Meta.Phase] === RunPhase.Summary ? (anyAlive(s) ? 'alive' : 'dead') : 'broken';

  return {
    profile: b.profile,
    seed,
    players,
    ticks: s.tick,
    outcome,
    victory: s.meta[Meta.Victory] === 1,
    finalFloor: s.meta[Meta.Floor],
    finalRoom: s.meta[Meta.Room],
    debtSeen,
    safetyBroken,
    maxEnemiesOnScreen,
    upgrades,
    bossFights,
    observed: observer.report(),
  };
}

export interface BalanceOptions {
  /** Прогонов `mixed` — основная популяция (см. шапку файла). */
  runs: number;
  seed: number;
}

export interface BalanceOutcome {
  readonly ok: boolean;
  readonly samples: number;
  readonly mixedRuns: number;
  readonly noneRuns: number;
  readonly report: ReturnType<typeof computeConstraints>;
  readonly text: string;
}

/**
 * Собрать выборку и посчитать ограничители. Не печатает и не завершает
 * процесс — этим занимается вызывающий код (`cli.ts`), чтобы модуль оставался
 * вызываемым и из тестов.
 */
export function runBalance(opts: BalanceOptions): BalanceOutcome {
  const mixedSamples: Sample[] = [];
  for (let i = 0; i < opts.runs; i++) {
    mixedSamples.push(runBalanceSample(opts.seed + i, 1, 'mixed'));
  }

  // Соль сида отделяет вторую популяцию от первой: иначе `novice:none` и
  // `mixed` на пересекающихся сидах различаются только ботом, а совпадение
  // сидов между населениями — случайность, которую лучше не заводить.
  const noneSamples: Sample[] = [];
  for (let i = 0; i < NONE_SUPPLEMENT_RUNS; i++) {
    noneSamples.push(runBalanceSample(opts.seed + 1_000_000 + i, 1, supplementBot(i)));
  }

  /*
   * Две выборки, не одна, и это не то же самое, что фильтр внутри g6.
   *
   * `novice:none` нужен ИСКЛЮЧИТЕЛЬНО как источник стратегии `none» для G1 и
   * G2 — больше ни для одного ограничителя эти прогоны не годятся, а для
   * G7/D2/D5/D6 (считаются по ВСЕЙ выборке без фильтра по стратегии) они
   * вредны: `novice:none` — это фиксированно СЛАБЫЙ навык (novice), который
   * не берёт пари, поэтому его смерти, длительность и достигнутый этаж не
   * похожи на смесь ECONOMY §6 ни разу — а составляют заметную долю пула
   * (`NONE_SUPPLEMENT_RUNS` при разумном `--runs` — десятки против сотен), и
   * молча подмешанные в G7/D2/D5/D6 они тянут «типичного игрока» к «слабому
   * трусу», а не к реальной смеси навыков (SIMULATION §3). Поэтому здесь два
   * прогона `computeConstraints`: один — ТОЛЬКО `mixed`, из него берётся всё,
   * кроме G1/G2 (для них `mixed` структурно не даёт ни одного образца —
   * `none` в смесь не входит намеренно, см. шапку файла); второй — с
   * добавленным `novice:none`, из него в финальный отчёт попадают только сами
   * G1 и G2.
   */
  const mixedOnlyReport = computeConstraints(mixedSamples, betCatalog);
  const combinedReport = computeConstraints([...mixedSamples, ...noneSamples], betCatalog);
  const combinedById = new Map(combinedReport.map((r) => [r.id, r] as const));
  const report = mixedOnlyReport.map((r) =>
    r.id === 'G1' || r.id === 'G2' ? (combinedById.get(r.id) ?? r) : r,
  );

  const red = report.filter((r) => r.verdict === 'red');
  const green = report.filter((r) => r.verdict === 'green');
  const skipped = report.filter((r) => r.verdict === 'not_measured');
  const totalSamples = mixedSamples.length + noneSamples.length;

  /*
   * Оборванные забеги — те, что упёрлись в потолок тиков, не дойдя до итогов,
   * и нулевые коны — карты, взятые на пустой кошелёк.
   *
   * Обе величины молчали, а идут они в знаменатели: оборванный забег с
   * неизвестным исходом считался наравне с доигранным, а нулевой кон — наравне
   * со ставкой. Первую строку отчёт обязан показывать, потому что она про
   * ИНСТРУМЕНТ (потолок мал или забег завис), вторую — потому что она про
   * экономику: доля пари, у которых ставить было нечем.
   */
  const all = [...mixedSamples, ...noneSamples];
  const broken = all.filter((r) => r.outcome === 'broken').length;
  const own = all.flatMap((r) => r.observed.bets.filter((b) => !b.ace));
  const zeroShare = own.length === 0 ? 0 : own.filter((b) => b.stake === 0).length / own.length;

  const header =
    `ГЕЙТ БАЛАНСА — 0.4.0, состав N=1 (кооп-составов нет)\n` +
    `выборка: ${opts.runs} × mixed (всё, кроме G1/G2) + ${NONE_SUPPLEMENT_RUNS} × none` +
    ` по смеси навыков (только G1/G2) = ${totalSamples} забегов · сид ${opts.seed}\n` +
    `профилей «навык:стратегия» в игре: ${PROFILE_NAMES.length}\n` +
    `оборвано потолком тиков: ${broken} · пари на нулевой кон: ` +
    `${(zeroShare * 100).toFixed(1)}% (в знаменатели долей не идут)\n`;
  const verdict = red.length === 0 ? 'ГЕЙТ ЗЕЛЁНЫЙ' : `ГЕЙТ КРАСНЫЙ — нарушено ${red.length}`;
  const text =
    `${header}\n${formatReport(report)}\n\n` +
    `${formatCalibration(calibrateBets(mixedSamples, betCatalog))}\n\n` +
    `${verdict} (${green.length} зелёных, ${red.length} красных, ${skipped.length} не считается)`;

  return {
    ok: red.length === 0,
    samples: totalSamples,
    mixedRuns: opts.runs,
    noneRuns: NONE_SUPPLEMENT_RUNS,
    report,
    text,
  };
}
