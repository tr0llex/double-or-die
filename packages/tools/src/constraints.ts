/**
 * Ограничители баланса: ECONOMY §13 (G1–G17) и DIFFICULTY §10 (D1–D10).
 *
 * Модуль не запускает симуляцию сам — он считает по уже готовым наблюдениям
 * (`Observer` из `observe.ts`) и по сводке забега, которую снимает раннер.
 * Так же, как `Observer` живёт СНАРУЖИ симуляции, этот модуль живёт снаружи
 * и `Observer`а: ему нужны не сырые тики, а то, что `Observer` и раннер уже
 * из них извлекли.
 *
 * Числа порогов взяты дословно из ECONOMY.md §13 и DIFFICULTY.md §10 — здесь
 * их нельзя ни ослаблять, ни ужесточать походя. Профили ботов и их привязка к
 * «осторожному / умеренному / наглому / мастеру» — из SIMULATION.md §3.
 *
 * КЛЮЧЕВОЕ ПРАВИЛО (ECONOMY §13, «Какие ограничители считаются в 0.4.0»):
 * ограничитель, слагаемых которого в игре ещё нет, не «зелёный» — он **не
 * считается**, и это обязано быть видно словом в отчёте. В 0.4.0 так не
 * считаются G9, G11, G13, G15, G16, G17 (см. `NOT_MEASURED` ниже) — ровно тот
 * список, что в ECONOMY §13. Остальные G и все D продолжают отвечать за себя.
 */

import { ROOMS_PER_FLOOR, UPGRADES, type SimState } from '@dod/sim';
import { STRATEGY_CASHES_OUT, type StrategyName } from './bots';
import type { BetRecord, HitRecord, Killer, Observation, RoomRecord } from './observe';

// ---------------------------------------------------------------------------
// Каталог множителей пари — нужен только G5 (дисперсия наглого профиля).
// `Observer` не хранит выплату, только исход, поэтому множитель по `id`
// берётся из каталога напрямую. Это НОМИНАЛЬНЫЙ множитель ECONOMY §2, а не
// этажный (§2 отмечает, что этажный живёт в конфиге и калибруется отдельно) —
// огрубление признано в отчёте, а не спрятано.
// ---------------------------------------------------------------------------

export interface BetCatalogEntry {
  readonly id: string;
  readonly multiplier: number;
}

// ---------------------------------------------------------------------------
// Данные одного забега, которых ограничителям хватает.
// ---------------------------------------------------------------------------

/** Кто отдал апгрейд игроку и по какой цене — считается снаружи `Observer`а. */
export interface UpgradeAcquisition {
  readonly player: number;
  readonly floor: number;
  /** `false` — Дар (GDD §5): в счётчик покупок G2/G3 не идёт. */
  readonly paid: boolean;
}

/** Один бой с боссом: сколько тиков он занял (D7 переводит их в секунды). */
export interface BossFight {
  readonly floor: number;
  readonly ticks: number;
  /**
   * Босс побеждён, а не бой оборван смертью игрока.
   *
   * D7 проверяет ДЛИТЕЛЬНОСТЬ боя — «сколько занимает победа над Рулеткой», —
   * и проигранный бой на этот вопрос не отвечает вовсе: он кончился тогда,
   * когда у игрока кончились сердца, то есть меряет живучесть, а не босса.
   * Пока разницы не было, отчёт показывал медиану 21 секунду при коридоре
   * 70–120 и выглядел приговором боссу, хотя ни один из двенадцати замеров
   * не был доигран до конца.
   */
  readonly won: boolean;
}

export interface Sample {
  readonly profile: string;
  readonly seed: number;
  readonly players: number;
  readonly ticks: number;
  readonly outcome: 'alive' | 'dead' | 'broken';
  /** `Meta.Victory` на конец забега: этаж пройден целиком, а не просто «жив». */
  readonly victory: boolean;
  readonly finalFloor: number;
  readonly finalRoom: number;
  /**
   * Хоть раз за забег было активно проклятие (`Meta.Curse`). Единственный
   * источник проклятия — долг (ECONOMY §10), поэтому это и есть «забег с
   * долгом» для G7.
   */
  readonly debtSeen: boolean;
  /** Достижимость безопасной точки нарушалась хоть раз (D4). */
  readonly safetyBroken: boolean;
  /** Максимум живых врагов одновременно за весь забег (D9). */
  readonly maxEnemiesOnScreen: number;
  readonly upgrades: readonly UpgradeAcquisition[];
  readonly bossFights: readonly BossFight[];
  readonly observed: Observation;
}

export type Verdict = 'green' | 'red' | 'not_measured';

export interface ConstraintResult {
  readonly id: string;
  readonly name: string;
  readonly threshold: string;
  /** Что намерили, словами — пусто у `not_measured`. */
  readonly measured: string;
  readonly verdict: Verdict;
  /** Обязателен у `not_measured`: почему нельзя посчитать (ECONOMY §13). */
  readonly reason?: string;
  readonly sampleSize: number;
}

const TICK_RATE = 60; // DEVLOOP §2: 3600 тиков = минута.

// ---------------------------------------------------------------------------
// Общие мелочи
// ---------------------------------------------------------------------------

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const stddev = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/**
 * Доля с половиной 95% доверительного интервала: `±1.96 √(p(1−p)/n)`.
 *
 * Вердикт по-прежнему ставится точечной оценкой — гейт обязан быть решением, а
 * не рассуждением, — но читатель отчёта имеет право видеть, различает ли
 * выборка порог вообще. «0.0% на 30 прогонах» и «0.0% на 1000» — это разные
 * утверждения, а выглядели они одинаково.
 */
const pctCi = (x: number, n: number): string =>
  `${(x * 100).toFixed(1)}% ±${(196 * Math.sqrt((x * (1 - x)) / Math.max(1, n))).toFixed(1)}`;

const inRange = (x: number, lo: number, hi: number): boolean => x >= lo && x <= hi;

/** Навык из профиля `навык:стратегия`. `null` у служебных ботов (idle, mixed…). */
const skillOf = (profile: string): string | null => profile.split(':')[0] ?? null;
const strategyOf = (profile: string): string | null => profile.split(':')[1] ?? null;

const byStrategy = (samples: readonly Sample[], strategy: string): Sample[] =>
  samples.filter((s) => strategyOf(s.profile) === strategy);

const byStrategies = (samples: readonly Sample[], strategies: readonly string[]): Sample[] =>
  samples.filter((s) => strategies.includes(strategyOf(s.profile) ?? ''));

const bySkills = (samples: readonly Sample[], skills: readonly string[]): Sample[] =>
  samples.filter((s) => skills.includes(skillOf(s.profile) ?? ''));

function result(
  id: string,
  name: string,
  threshold: string,
  sampleSize: number,
  compute: () => { measured: string; verdict: 'green' | 'red' },
): ConstraintResult {
  if (sampleSize === 0) {
    return {
      id,
      name,
      threshold,
      measured: '',
      verdict: 'not_measured',
      reason: 'нет ни одного подходящего прогона в выборке',
      sampleSize: 0,
    };
  }
  const { measured, verdict } = compute();
  return { id, name, threshold, measured, verdict, sampleSize };
}

function notMeasured(
  id: string,
  name: string,
  threshold: string,
  reason: string,
): ConstraintResult {
  return { id, name, threshold, measured: '', verdict: 'not_measured', reason, sampleSize: 0 };
}

// ---------------------------------------------------------------------------
// G1–G8, G10, G12, G14 — считаются в 0.4.0 (ECONOMY §13)
// ---------------------------------------------------------------------------

/** Осторожный (SIMULATION §3): стратегия `none`, любой навык. */
function g1(samples: readonly Sample[]): ConstraintResult {
  const s = byStrategy(samples, 'none');
  return result('G1', 'Осторожный проходит первый этаж целиком', '≥ 90% прогонов', s.length, () => {
    const passed = s.filter((r) => r.finalFloor >= 2 || r.victory).length;
    const share = passed / s.length;
    return { measured: pctCi(share, s.length), verdict: share >= 0.9 ? 'green' : 'red' };
  });
}

/**
 * Забег, у которого БЫЛА возможность распорядиться деньгами.
 *
 * G2 и G3 считают покупки за забег: один — потолок («не больше двух»), другой
 * — пол («четыре и больше»). Забег, оборвавшийся в третьей комнате первого
 * этажа, не проверяет ни то, ни другое: лавка встречается не позже пятой
 * комнаты (`DOORS.shopBy`), то есть такой забег видел её в лучшем случае
 * однажды и почти наверняка без денег.
 *
 * Пока этого условия не было, G2 стоял ЗЕЛЁНЫМ на выборке, где 177 забегов из
 * 200 не покупали вообще ничего: «не больше двух» выполнялось бедностью, а не
 * балансом. Зелёный по бедности хуже красного — красный виден.
 */
const hadShoppingChance = (r: Sample): boolean => r.finalFloor >= 2 || r.victory;

function g2(samples: readonly Sample[]): ConstraintResult {
  const s = byStrategy(samples, 'none').filter(hadShoppingChance);
  if (s.length === 0) {
    return notMeasured(
      'G2',
      'Осторожный покупает не больше двух апгрейдов за забег',
      'всегда',
      'ни один осторожный забег не прошёл этаж целиком — покупать было не на что и негде',
    );
  }
  return result(
    'G2',
    'Осторожный покупает не больше двух апгрейдов за забег',
    'всегда',
    s.length,
    () => {
      let worst = 0;
      for (const r of s) {
        const byPlayer = new Map<number, number>();
        for (const u of r.upgrades)
          if (u.paid) byPlayer.set(u.player, (byPlayer.get(u.player) ?? 0) + 1);
        for (const n of byPlayer.values()) worst = Math.max(worst, n);
      }
      return { measured: `максимум ${worst} за забег`, verdict: worst <= 2 ? 'green' : 'red' };
    },
  );
}

/** Играющий на ставках (SIMULATION §3): `stack` и `chips`. */
function g3(samples: readonly Sample[]): ConstraintResult {
  const s = byStrategies(samples, ['stack', 'chips']).filter(hadShoppingChance);
  if (s.length === 0) {
    return notMeasured(
      'G3',
      'Играющий на ставках покупает четыре апгрейда и больше',
      '≥ 70% прогонов',
      'ни один ставочный забег не прошёл этаж целиком — четырёх лавок в выборке не было',
    );
  }
  return result(
    'G3',
    'Играющий на ставках покупает четыре апгрейда и больше',
    '≥ 70% прогонов',
    s.length,
    () => {
      let ok = 0;
      for (const r of s) {
        const byPlayer = new Map<number, number>();
        for (const u of r.upgrades)
          if (u.paid) byPlayer.set(u.player, (byPlayer.get(u.player) ?? 0) + 1);
        const best = Math.max(0, ...byPlayer.values());
        if (best >= 4) ok++;
      }
      const share = ok / s.length;
      return { measured: pctCi(share, s.length), verdict: share >= 0.7 ? 'green' : 'red' };
    },
  );
}

/** Опытные (SIMULATION §3): `veteran` и `master`, любая ставочная стратегия. */
function g4(samples: readonly Sample[]): ConstraintResult {
  const s = byStrategies(bySkills(samples, ['veteran', 'master']), ['single', 'stack', 'chips']);
  return result(
    'G4',
    'Верхний аппетит выбирается опытными реже 70%',
    'иначе экономика сломана',
    s.length,
    () => {
      let goBig = 0;
      let taken = 0;
      for (const r of s)
        for (const b of r.observed.bets) {
          taken++;
          if (b.tier === 'go_big') goBig++;
        }
      if (taken === 0) return { measured: 'пари не взяты вовсе', verdict: 'red' as const };
      const share = goBig / taken;
      return { measured: pctCi(share, taken), verdict: share < 0.7 ? 'green' : 'red' };
    },
  );
}

/** Наглый профиль ECONOMY §6 — сборка без обналичивания, опорный навык `median`. */
function g5(samples: readonly Sample[]): ConstraintResult {
  const s = bySkills(byStrategy(samples, 'stack'), ['median']);
  return result(
    'G5',
    'Дисперсия наглого профиля не меньше 1.5× его ожидания',
    'всегда',
    s.length,
    () => {
      const net = s.map((r) => netBetEarnings(r.observed.bets.filter(isRealBet)));
      const m = mean(net);
      const sd = stddev(net);
      // Ожидание близко к нулю или отрицательное делает отношение неопределённым
      // либо бессмысленно большим — это тоже красный сигнал, а не деление на ноль.
      if (m <= 0)
        return {
          measured: `ожидание ${m.toFixed(1)} ≤ 0, σ ${sd.toFixed(1)}`,
          verdict: 'red' as const,
        };
      const ratio = sd / m;
      return {
        measured: `σ/ожидание = ${ratio.toFixed(2)} (ожидание ${m.toFixed(1)}, σ ${sd.toFixed(1)})`,
        verdict: ratio >= 1.5 ? 'green' : 'red',
      };
    },
  );
}

/**
 * Чистый доход с пари: сколько игрок ПОЛУЧИЛ минус сколько поставил.
 *
 * Обе величины теперь снимает наблюдатель по правилам самого ядра
 * (`BetRecord.payout`), поэтому здесь не осталось ни номинального множителя,
 * ни огрубления `q≈1` для обналиченного — раньше и то и другое считало не
 * фактический доход, а его модель. Ставка Крупье в счёт не идёт: её кон
 * ставит он, и в дисперсию профиля игрока она входить не может.
 */
function netBetEarnings(bets: readonly BetRecord[]): number {
  let sum = 0;
  for (const b of bets) {
    if (b.ace || b.outcome === 'active') continue;
    sum += b.payout - b.stake;
  }
  return sum;
}

/**
 * Пари, которое действительно было ставкой.
 *
 * Кон считается как `min(тир аппетита, кошелёк)`, и на пустом кошельке он
 * НОЛЬ: карта подбирается, ничего не списывается, выигрыш платит `0 × M`,
 * провал стоит ноль (ECONOMY §4). Такая запись — не ставка, а жест, и в
 * знаменателях долей она шум: замер до починки ботов держал в ней треть
 * всех записей. Доля нулевых конов остаётся видимой — она печатается
 * отдельной строкой отчёта как показатель здоровья экономики.
 */
const isRealBet = (b: BetRecord): boolean => !b.ace && b.stake > 0;

/**
 * G6 считается по смеси профилей ровно как SIMULATION §3 велит: `--bot mixed`.
 *
 * Стратегия `none` исключается ЗДЕСЬ, а не только выбором того, что подать на
 * вход: `none` не берёт пари никогда, и заметная её доля в выборке валила бы
 * ограничитель составом смеси, а не балансом игры (SIMULATION §3, «Профиль
 * `none` в смесь не входит, и это не забывчивость»). `mixed` сам `none` не
 * порождает, но G1/G2 нужен отдельный прогон `novice:none` в той же выборке
 * (SIMULATION §3 называет его по имени) — без фильтра здесь этот прогон
 * подмешивался бы в знаменатель G6 и портил бы ограничитель тем самым
 * способом, от которого его бережёт исключение `none` из `mixed`.
 */
function g6(samples: readonly Sample[]): ConstraintResult {
  const s = samples.filter(
    (r) => r.profile !== 'idle' && r.profile !== 'random' && strategyOf(r.profile) !== 'none',
  );
  return result('G6', 'Доля забегов с нулём взятых пари', '< 5%', s.length, () => {
    const zero = s.filter((r) => r.observed.bets.length === 0).length;
    const share = zero / s.length;
    return { measured: pctCi(share, s.length), verdict: share < 0.05 ? 'green' : 'red' };
  });
}

function g7(samples: readonly Sample[]): ConstraintResult {
  return result('G7', 'Доля забегов с долгом', '15–35%', samples.length, () => {
    const withDebt = samples.filter((r) => r.debtSeen).length;
    const share = withDebt / samples.length;
    return { measured: pctCi(share, samples.length), verdict: inRange(share, 0.15, 0.35) ? 'green' : 'red' };
  });
}

function g8(samples: readonly Sample[]): ConstraintResult {
  const s = bySkills(samples, ['median']);
  return result('G8', 'Победа в забеге у медианного игрока', '25–40%', s.length, () => {
    const won = s.filter((r) => r.victory).length;
    const share = won / s.length;
    return { measured: pctCi(share, s.length), verdict: inRange(share, 0.25, 0.4) ? 'green' : 'red' };
  });
}

/**
 * Пороги G10 — доли от РАВНОМЕРНОЙ, а не абсолютные числа.
 *
 * «Не реже 3% и не чаще 25%» посчитано на полном каталоге из 24 пари, где
 * равномерная доля 4.17%: три процента — это 0.72 равномерной, «вчетверо ниже
 * своей доли с небольшим запасом». А вот двадцать пять — это ШЕСТЬ
 * равномерных: пари, забирающее вшестеро больше своей доли, ограничитель
 * пропускал зелёным, то есть верхняя граница не ловила доминирование ни на
 * каком каталоге. В 0.4.0 с шестью пари она и вовсе недостижима (25% против
 * равномерных 16.7% — полторы доли).
 *
 * Та же болезнь была у D5/D6 и там уже вылечена формулой от `K`
 * (DIFFICULTY §10). Здесь лечится так же: нижняя граница сохраняет
 * документированный смысл (0.72 равномерной — при 24 пари ровно прежние 3%),
 * верхняя становится тем, чем её называет само название ограничителя, —
 * порогом доминирования: **два с половиной раза своей доли**. При 24 пари это
 * 10.4% вместо 25%, при шести — 41.7%.
 */
const G10_DEAD = 0.72;
const G10_DOMINANT = 2.5;

function g10(samples: readonly Sample[], betIds: readonly string[]): ConstraintResult {
  const k = betIds.length;
  const dead = G10_DEAD / k;
  const dominant = G10_DOMINANT / k;
  // Нулевой кон — не ставка (см. `isRealBet`), и в знаменателе охвата ему не
  // место: он говорит о пустом кошельке, а не о том, берут ли это пари.
  const records = samples.flatMap((r) => r.observed.bets.filter(isRealBet));
  return result(
    'G10',
    'Каждое пари берут не реже 0.72 и не чаще 2.5 равномерной доли',
    `${pct(dead)}–${pct(dominant)} при K=${k}`,
    records.length,
    () => {
      const perId = new Map<string, number>();
      for (const b of records) perId.set(b.id, (perId.get(b.id) ?? 0) + 1);
      const shareOf = (id: string): number => (perId.get(id) ?? 0) / records.length;
      const rows = betIds.map((id) => `${id}=${pct(shareOf(id))}`);
      const cold = betIds.filter((id) => shareOf(id) < dead);
      const hot = betIds.filter((id) => shareOf(id) > dominant);
      const detail = [
        rows.join(', '),
        cold.length ? `мёртвые: ${cold.join(', ')}` : '',
        hot.length ? `доминируют: ${hot.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return { measured: detail, verdict: cold.length || hot.length ? 'red' : 'green' };
    },
  );
}

/** Ставка Крупье — по флагу наблюдателя, а не по внутренней метке ядра. */
const isAceRecord = (b: BetRecord): boolean => b.ace;

function g12(samples: readonly Sample[]): ConstraintResult {
  const s = samples;
  const records = s.flatMap((r) =>
    r.observed.bets.filter((b) => isAceRecord(b) && (b.outcome === 'won' || b.outcome === 'lost')),
  );
  return result('G12', 'Ставка Крупье: ожидание для игрока', '0 … +5%', records.length, () => {
    const won = records.filter((b) => b.outcome === 'won').length;
    const p = won / records.length;
    const ev = 2 * p - 1; // выплата один к одному (ECONOMY §10А).
    return {
      measured: `p=${pctCi(p, records.length)}, EV=${(ev * 100).toFixed(1)}% кона`,
      verdict: inRange(ev, 0, 0.05) ? 'green' : 'red',
    };
  });
}

/**
 * G14 считается по тем пари, где решение «Забрать» ВООБЩЕ существовало.
 *
 * ECONOMY §9А говорит прямо: «профиль наглый по определению не обналичивает»,
 * и именно поэтому по нему считается G5. Его пари в знаменателе G14 делают
 * ограничитель красным по построению — доля обналиченных не может подняться
 * выше доли обналичивающих профилей в выборке, как бы ни была устроена сама
 * кнопка. Считаем по стратегиям, которым обналичивание доступно
 * (`STRATEGY_CASHES_OUT`, `bots.ts`), и по настоящим ставкам: Ставку Крупье
 * «Забрать» не берёт вовсе (кон чужой), нулевой кон нечего забирать.
 */
function g14(samples: readonly Sample[]): ConstraintResult {
  const canCash = samples.filter((r) => {
    const st = strategyOf(r.profile) as StrategyName | null;
    return st !== null && STRATEGY_CASHES_OUT[st] === true;
  });
  const resolved = canCash.flatMap((r) =>
    r.observed.bets.filter((b) => isRealBet(b) && b.outcome !== 'active'),
  );
  return result(
    'G14',
    'Доля пари, закрытых через «Забрать» (у профилей, которые обналичивают)',
    '15–35%',
    resolved.length,
    () => {
      const cashed = resolved.filter((b) => b.outcome === 'cashed').length;
      const share = cashed / resolved.length;
      return { measured: pctCi(share, resolved.length), verdict: inRange(share, 0.15, 0.35) ? 'green' : 'red' };
    },
  );
}

// ---------------------------------------------------------------------------
// D1–D10 — DIFFICULTY §10. «Остальные D в 0.4.0 считаются все» — кроме тех
// двух, что физически не измерить этим инструментом (см. `notMeasured`).
// ---------------------------------------------------------------------------

function d1(samples: readonly Sample[]): ConstraintResult {
  // Сравнение честное только внутри ОДНОГО профиля на разных составах: пул
  // при N=1 обычно куда шире (все профили «навык:стратегия» разом), и сложить
  // его медиану с медианой одного профиля при N=2..4 значило бы сравнивать
  // разное с разным. Берём только те профили, что прогонялись больше чем на
  // одном составе.
  const multiN = new Set(samples.filter((r) => r.players > 1).map((r) => r.profile));
  const relevant = samples.filter((r) => multiN.has(r.profile));

  const byN = new Map<number, number[]>();
  for (const r of relevant) {
    const ticks = r.observed.rooms.map((x) => x.ticks);
    if (ticks.length === 0) continue;
    const arr = byN.get(r.players) ?? [];
    arr.push(median(ticks));
    byN.set(r.players, arr);
  }
  const perN = [...byN.entries()]
    .map(([n, xs]) => [n, median(xs)] as const)
    .filter(([, m]) => m > 0);
  if (perN.length < 2) {
    return notMeasured(
      'D1',
      'Длительность комнаты не зависит от числа игроков',
      'разброс < 15%',
      'сравнивать не с чем: гейт 0.4.0 гоняет только состав N=1, составы 2–4 приезжают с 0.5.0',
    );
  }
  return result(
    'D1',
    'Длительность комнаты не зависит от числа игроков',
    'разброс < 15%',
    perN.length,
    () => {
      const vals = perN.map(([, m]) => m);
      const avg = mean(vals);
      const spread = (Math.max(...vals) - Math.min(...vals)) / avg;
      const detail = perN.map(([n, m]) => `N${n}=${(m / TICK_RATE).toFixed(1)}с`).join(', ');
      return {
        measured: `${detail} (разброс ${pct(spread)})`,
        verdict: spread < 0.15 ? 'green' : 'red',
      };
    },
  );
}

/**
 * D2 ранжирует забеги по ПРОЙДЕННОМУ ПУТИ, а не берёт две медианы порознь.
 *
 * Раньше считались медиана этажа и медиана комнаты по отдельности и склеивались
 * в пару. Такая пара не обязана встречаться ни в одном забеге: если половина
 * забегов кончается на этаже 1 в комнате 7, а половина на этаже 2 в комнате 2,
 * «медианный забег» получался этаж 2, комната 4 — состояние, которого не было
 * ни у кого. Правильная величина одна: путь `(этаж−1)×8 + комната`, и медиана
 * берётся по нему.
 */
function d2(samples: readonly Sample[]): ConstraintResult {
  return result(
    'D2',
    'Медианный забег заканчивается на этаже 2, комнаты 4–8',
    'этаж 2, комнаты 4–8',
    samples.length,
    () => {
      const progress = samples.map((r) => (r.finalFloor - 1) * ROOMS_PER_FLOOR + r.finalRoom);
      const m = median(progress);
      const floor = Math.floor((m - 1) / ROOMS_PER_FLOOR) + 1;
      const room = m - (floor - 1) * ROOMS_PER_FLOOR;
      const ok = floor === 2 && inRange(room, 4, 8);
      return { measured: `этаж ${floor}, комната ${room}`, verdict: ok ? 'green' : 'red' };
    },
  );
}

function d3(samples: readonly Sample[]): ConstraintResult {
  const s = bySkills(samples, ['median']);
  return result('D3', 'Доля побед у медианного игрока', '25–40%', s.length, () => {
    const won = s.filter((r) => r.victory).length;
    const share = won / s.length;
    return { measured: pctCi(share, s.length), verdict: inRange(share, 0.25, 0.4) ? 'green' : 'red' };
  });
}

function d4(samples: readonly Sample[]): ConstraintResult {
  return result('D4', 'Безопасная точка существует всегда', '100% тиков', samples.length, () => {
    const broken = samples.filter((r) => r.safetyBroken).length;
    const share = 1 - broken / samples.length;
    return {
      measured: `${pct(share)} прогонов без срыва (${broken} сорванных из ${samples.length})`,
      verdict: broken === 0 ? 'green' : 'red',
    };
  });
}

const KNOWN_KILLERS: readonly Killer[] = ['wedge', 'brick', 'fuse'];

function killerShares(samples: readonly Sample[]): {
  shares: Map<Killer, number>;
  unknown: number;
  total: number;
} {
  const fatal = samples.flatMap((r) => r.observed.hits.filter((h) => h.fatal));
  const known = fatal.filter((h) => h.by !== 'unknown');
  const shares = new Map<Killer, number>();
  for (const k of KNOWN_KILLERS)
    shares.set(k, known.filter((h) => h.by === k).length / (known.length || 1));
  const unknown = (fatal.length - known.length) / (fatal.length || 1);
  return { shares, unknown, total: fatal.length };
}

/** K — число врагов, доступных в проверяемом прогоне (DIFFICULTY §10). В 0.4.0 их три. */
const ENEMY_COUNT_04 = 3;

function d5(samples: readonly Sample[]): ConstraintResult {
  return result(
    'D5',
    'Ни один враг не даёт больше 25% всех смертей',
    `≤ ${((2.25 / ENEMY_COUNT_04) * 100).toFixed(1)}% (2.25/K, K=${ENEMY_COUNT_04})`,
    samples.length,
    () => {
      const { shares, unknown, total } = killerShares(samples);
      if (total === 0)
        return { measured: 'смертей от врагов не зафиксировано', verdict: 'red' as const };
      const threshold = 2.25 / ENEMY_COUNT_04;
      const worst = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
      const detail = `${[...shares.entries()].map(([k, v]) => `${k}=${pct(v)}`).join(', ')} (unknown ${pct(unknown)})`;
      return { measured: detail, verdict: worst[1] <= threshold ? 'green' : 'red' };
    },
  );
}

function d6(samples: readonly Sample[]): ConstraintResult {
  return result(
    'D6',
    'Ни один враг не даёт меньше 3% смертей',
    `≥ ${((0.27 / ENEMY_COUNT_04) * 100).toFixed(1)}% (0.27/K, K=${ENEMY_COUNT_04})`,
    samples.length,
    () => {
      const { shares, unknown, total } = killerShares(samples);
      if (total === 0)
        return { measured: 'смертей от врагов не зафиксировано', verdict: 'red' as const };
      const threshold = 0.27 / ENEMY_COUNT_04;
      const worst = [...shares.entries()].sort((a, b) => a[1] - b[1])[0];
      const detail = `${[...shares.entries()].map(([k, v]) => `${k}=${pct(v)}`).join(', ')} (unknown ${pct(unknown)})`;
      return { measured: detail, verdict: worst[1] >= threshold ? 'green' : 'red' };
    },
  );
}

function d7(samples: readonly Sample[]): ConstraintResult {
  const fights = samples.flatMap((r) => r.bossFights).filter((f) => f.won);
  if (fights.length === 0) {
    return notMeasured(
      'D7',
      'Бой с боссом',
      '70–120 с',
      'ни один бой с боссом не доигран до победы — мерить длительность нечем',
    );
  }
  return result('D7', 'Бой с боссом', '70–120 с', fights.length, () => {
    const seconds = fights.map((f) => f.ticks / TICK_RATE);
    const m = median(seconds);
    const bad = seconds.filter((s) => !inRange(s, 70, 120)).length;
    return {
      measured: `медиана ${m.toFixed(1)}с, вне коридора ${bad}/${seconds.length}`,
      verdict: inRange(m, 70, 120) && bad / seconds.length < 0.1 ? 'green' : 'red',
    };
  });
}

function d9(samples: readonly Sample[]): ConstraintResult {
  const byN = new Map<number, number[]>();
  for (const r of samples) {
    const arr = byN.get(r.players) ?? [];
    arr.push(r.maxEnemiesOnScreen);
    byN.set(r.players, arr);
  }
  return result('D9', 'Врагов на экране одновременно', '≤ 40 + 15(N−1)', samples.length, () => {
    const bad: string[] = [];
    const rows: string[] = [];
    for (const [n, xs] of byN) {
      const cap = 40 + 15 * (n - 1);
      const worst = Math.max(...xs);
      rows.push(`N${n}: ${worst}/${cap}`);
      if (worst > cap) bad.push(`N${n}`);
    }
    return { measured: rows.join(', '), verdict: bad.length === 0 ? 'green' : 'red' };
  });
}

// ---------------------------------------------------------------------------
// Сборка отчёта
// ---------------------------------------------------------------------------

export function computeConstraints(
  samples: readonly Sample[],
  betCatalog: readonly BetCatalogEntry[],
): ConstraintResult[] {
  const betIds = betCatalog.map((b) => b.id);

  return [
    g1(samples),
    g2(samples),
    g3(samples),
    g4(samples),
    g5(samples),
    g6(samples),
    g7(samples),
    g8(samples),
    // G9 — потолок множителя: собирается из сборки, «На кураже» и двух
    // «Удвоим?», и ни одного из трёх слагаемых в 0.4.0 нет (ECONOMY §13).
    notMeasured(
      'G9',
      'Потолок множителя достигается',
      '0.5–2% забегов',
      'считается с 0.6.0 — механик «На кураже» и «Удвоим?» ещё нет',
    ),
    g10(samples, betIds),
    // G11 — паритет соло/коопа: составов 2–4 в версии нет.
    notMeasured(
      'G11',
      'Доход за забег: соло против коопа на игрока',
      'расхождение < 15%',
      'считается с 0.5.0 — составов 2–4 в 0.4.0 нет',
    ),
    g12(samples),
    // G13 — Последняя сделка: механики нет вовсе.
    notMeasured(
      'G13',
      'Последняя сделка: доля успешных',
      '40–50%',
      'считается с 0.6.0 — механики «Последняя сделка» ещё нет',
    ),
    g14(samples),
    // G15/G16 — кооп-ограничители, составов 2–4 в версии нет.
    notMeasured(
      'G15',
      'Доля карт, подобранных с арены',
      '55–80% при любом составе 1–4',
      'считается с 0.5.0 — составов 2–4 в 0.4.0 нет',
    ),
    notMeasured(
      'G16',
      'Пари за забег у самого пассивного игрока команды',
      'не меньше половины от самого активного',
      'считается с 0.5.0 — составов 2–4 в 0.4.0 нет',
    ),
    // G17 — максимальная сборка: та же причина, что у G9.
    notMeasured(
      'G17',
      'Доля забегов с максимальной сборкой',
      '10–30%',
      'считается с 0.6.0 — сборка собирается теми же тремя механиками, что и G9',
    ),

    d1(samples),
    d2(samples),
    d3(samples),
    d4(samples),
    d5(samples),
    d6(samples),
    d7(samples),
    // D8 — отдача любого оружия против пистоля: второго оружия в 0.4.0 нет,
    // сравнивать не с чем (DEVLOOP §6А: «Отдача оружия (5)» приезжает в 0.7.0).
    notMeasured(
      'D8',
      'Отдача любого оружия в пределах ±20% от пистоля',
      'всегда',
      'считается с 0.7.0 — второго оружия ещё нет, сравнивать не с чем',
    ),
    d9(samples),
    // D10 — кадр в худшей волне: это `npm run bench` (рендер клиента),
    // headless-симуляция кадров не рисует и FPS не имеет.
    notMeasured(
      'D10',
      'Кадр в худшей волне',
      '≥ 60 FPS',
      'не измеряется headless-симуляцией — см. `npm run bench`, это рендер клиента',
    ),
  ];
}

// ---------------------------------------------------------------------------
// Диагностика §2: каждое пари против своей целевой вероятности
// ---------------------------------------------------------------------------

/**
 * Целевая вероятность успеха по множителю — таблица ECONOMY §2 дословно.
 *
 * Точка безубыточности `p = 1/M`, цели поставлены выше неё так, чтобы каждое
 * пари было слегка выгодным: +10…15% кона. Ни один ограничитель G/D этого
 * НЕ ПРОВЕРЯЕТ — G10 считает, как часто пари берут, но не то, чем оно
 * кончается, — и промах вдвое (замер: «Быстрее 45 с» выигрывалось в 74.8%
 * при цели 55%, «Без рывка» в 4.4%) не показывал в отчёте ни один знак.
 * Гейтом эта таблица не становится: пороги §2 — цели калибровки, а не ворота
 * версии. Но видеть её обязан всякий, кто трогает множители.
 */
const TARGET_P_BY_MULTIPLIER: readonly (readonly [number, number])[] = [
  [2.0, 0.55],
  [2.5, 0.45],
  [3.0, 0.38],
  [3.5, 0.33],
];

const targetP = (multiplier: number): number => {
  let best = TARGET_P_BY_MULTIPLIER[0];
  for (const row of TARGET_P_BY_MULTIPLIER) {
    if (Math.abs(row[0] - multiplier) < Math.abs(best[0] - multiplier)) best = row;
  }
  return best[1];
};

export interface BetCalibration {
  readonly id: string;
  readonly multiplier: number;
  readonly taken: number;
  readonly resolved: number;
  readonly p: number;
  readonly targetP: number;
  /** Матожидание в долях кона: `p × M − 1`. Цель §2 — +10…15%. */
  readonly ev: number;
}

export function calibrateBets(
  samples: readonly Sample[],
  betCatalog: readonly BetCatalogEntry[],
): BetCalibration[] {
  const records = samples.flatMap((r) => r.observed.bets.filter(isRealBet));
  return betCatalog.map((b) => {
    const mine = records.filter((r) => r.id === b.id);
    // Обналиченное в вероятность успеха не идёт: игрок сам оборвал проверку,
    // и засчитывать её в любую сторону значило бы мерить не условие пари.
    const won = mine.filter((r) => r.outcome === 'won').length;
    const lost = mine.filter((r) => r.outcome === 'lost').length;
    const resolved = won + lost;
    const p = resolved === 0 ? 0 : won / resolved;
    return {
      id: b.id,
      multiplier: b.multiplier,
      taken: mine.length,
      resolved,
      p,
      targetP: targetP(b.multiplier),
      ev: p * b.multiplier - 1,
    };
  });
}

export function formatCalibration(rows: readonly BetCalibration[]): string {
  const lines = ['ПАРИ ПРОТИВ ЦЕЛЕЙ ECONOMY §2 (не гейт — цель калибровки)', ''];
  for (const r of rows) {
    const miss = r.p - r.targetP;
    const mark = Math.abs(miss) <= 0.05 ? '·' : miss > 0 ? '↑' : '↓';
    lines.push(
      `${mark} ${r.id.padEnd(14)} ×${r.multiplier.toFixed(1)}  ` +
        `успех ${pctCi(r.p, r.resolved)} при цели ${pct(r.targetP)}  ` +
        `EV ${(r.ev * 100 >= 0 ? '+' : '') + (r.ev * 100).toFixed(0)}% кона (цель +10…15%)  ` +
        `· разрешено ${r.resolved}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Человекочитаемый отчёт
// ---------------------------------------------------------------------------

const ICON: Record<Verdict, string> = { green: '✓', red: '✗', not_measured: '·' };

export function formatReport(results: readonly ConstraintResult[]): string {
  const lines: string[] = [];
  const green = results.filter((r) => r.verdict === 'green').length;
  const red = results.filter((r) => r.verdict === 'red').length;
  const skipped = results.filter((r) => r.verdict === 'not_measured').length;
  lines.push(
    `ОГРАНИЧИТЕЛИ БАЛАНСА  ·  зелёных ${green} · красных ${red} · не считается ${skipped}`,
  );
  lines.push('');
  for (const r of results) {
    const head = `${ICON[r.verdict]} ${r.id.padEnd(4)} ${r.name}`;
    if (r.verdict === 'not_measured') {
      lines.push(`${head}\n      не считается: ${r.reason}`);
      continue;
    }
    lines.push(
      `${head}\n      порог: ${r.threshold}  ·  факт: ${r.measured}  ·  выборка: ${r.sampleSize}`,
    );
  }
  return lines.join('\n');
}

// Реэкспорт типов наблюдателя, которыми оперирует раннер, собирающий `Sample`.
export type { BetRecord, HitRecord, Killer, Observation, RoomRecord };
export { UPGRADES };
export type { SimState };
