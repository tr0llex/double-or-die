/**
 * Боты — не искусственный интеллект, а явно заданные стратегии для проверки
 * систем. `idle` доказывает, что игра не зависает сама по себе; `random` ищет
 * состояния, до которых человек не додумается.
 *
 * Боты живут в инструментах, а не в ядре: они порождают ввод, а не логику.
 *
 * Главное решение файла — **две независимые оси** (SIMULATION §3). Навык
 * отвечает за руки: точность прицела, долю времени со стрельбой, качество
 * уклонения и рывок. Стратегия отвечает за деньги: сколько карт брать, каким
 * тиром и когда соскакивать. Оси разведены потому, что половина порогов
 * ограничителей задана через профили игрока (ECONOMY §6), а профили эти
 * отличаются друг от друга ОБЕИМИ величинами сразу: наглый и мастер играют
 * одну и ту же стратегию с разным навыком, и разница между ними — это и есть
 * разница между «+160 за этаж» и «+330». Бот, который целится точно и жмёт
 * огонь постоянно, меряет сверхмастера при любой стратегии, то есть не меряет
 * ни один из четырёх профилей.
 */

import {
  type InputFrame,
  type SimState,
  ANGLE_FULL,
  APPETITE,
  BetId,
  BetState,
  Btn,
  DoorType,
  EnemyPhase,
  EnemyType,
  ENEMY_OWNER,
  MAX_BULLETS,
  PLAYER,
  Stream,
  UPGRADES,
  UpgradeEffect,
  aceCardAt,
  add,
  cos,
  createStreams,
  fromFloat,
  fromInt,
  makeFrame,
  mul,
  nextInt,
  normX,
  normY,
  normalize,
  sin,
  sub,
  withAppetite,
  EntityFlag,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  MAX_DOORS,
  Meta,
  RunPhase,
  MAX_CHIPS,
  MAX_ENEMIES,
  RED_ZONE_RADIUS,
  SHARED,
  SHOP_SLOTS,
  canBuy,
  redZoneX,
  redZoneY,
  toFloat,
  wheelX,
  wheelY,
  type RngState,
} from '@dod/sim';

import { findSafePoint } from './safety';

/**
 * Тир аппетита «По-крупному».
 *
 * Через `withAppetite`, а не битом `Btn.AppetiteHi`: два бита кодируют тир СО
 * СДВИГОМ на единицу, потому что четвёртое значение обязано означать «игрок
 * сейчас молчит» (`appetiteOf` в `input.ts`). Старший бит в одиночку читается
 * как тир 1, то есть «Нормально», — и жадный бот, объявлявший себя наглым
 * профилем, ставил половину заявленного кона. Замер тем и ловится: кон 25 там,
 * где ECONOMY §6 считает 50.
 */
const TIER_GO_BIG = 2;

/**
 * Ось навыка (SIMULATION §3). Опорный профиль — `median`: из его 0.75 и 0.5
 * посчитан реальный урон 25 HP/с, от которого выведена вся сложность
 * (DIFFICULTY §1).
 */
export const SKILL_NAMES = ['novice', 'median', 'veteran', 'master'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

interface Skill {
  /** Доля выстрелов, идущих точно в цель, в процентах. */
  readonly aimPct: number;
  /** Доля времени с зажатым курком, в процентах. */
  readonly firePct: number;
  /**
   * Качество уклонения, в процентах. Им же задана и доля использования рывка.
   *
   * Отдельного числа под рывок в документах нет, и выдумывать второе
   * независимое значение незачем: уклонение и рывок — одно умение, а рывок
   * ещё и главный инструмент выживания (ECONOMY §5). Появится замер по живым
   * игрокам (0.11.0) — разъедутся два числа, а не одно превратится в два.
   */
  readonly dodgePct: number;
}

/**
 * Экспортирована: абстрактная модель (`abstract.ts`) выводит урон и попадания
 * по навыку из тех же чисел, что и бот, — единственный источник, а не две
 * копии таблицы SIMULATION §3, которые могут разъехаться порознь.
 */
export const SKILL_TABLE: Record<SkillName, Skill> = {
  novice: { aimPct: 60, firePct: 35, dodgePct: 30 },
  median: { aimPct: 75, firePct: 50, dodgePct: 50 },
  veteran: { aimPct: 85, firePct: 60, dodgePct: 70 },
  master: { aimPct: 93, firePct: 70, dodgePct: 85 },
};
const SKILLS = SKILL_TABLE;

/**
 * Ось стратегии ставок. Соответствие профилям игрока из ECONOMY §6:
 * `none` — осторожный (ноль ставок), `single` — умеренный (одно пари за
 * комнату, кон 25), `stack` — наглый (сборка, кон 50, не обналичивает),
 * `chips` — та же сборка плюс погоня за фишками на полу.
 *
 * Четвёртая стратегия заведена не для симметрии. ECONOMY §4 держит разрыв
 * между «одна фишка за комнату у того, кто за ними не ходит» и целевыми
 * четырьмя — это цена жадности, и калибруется она ботом, который за фишками
 * ходит. Без него дроп настраивается вслепую.
 */
export const STRATEGY_NAMES = ['none', 'single', 'stack', 'chips'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

interface Strategy {
  /** Сколько пари бот держит одновременно. Ноль — не берёт карт вовсе. */
  readonly maxBets: number;
  /**
   * Аппетит, которым стратегия ИГРАЕТ, когда кошелёк это позволяет: 0
   * «Скромно», 1 «Нормально», 2 «По-крупному» (SIMULATION §3).
   *
   * Именно потолок, а не назначенный тир, — см. `tierFor` ниже.
   */
  readonly tier: number;
  /** Обналичивать ли, потеряв сердце. */
  readonly cashOutOnHurt: boolean;
  /** Ходить ли за фишками, лежащими на полу. */
  readonly chaseChips: boolean;
}

/**
 * Умеет ли стратегия обналичивать вообще.
 *
 * Экспортируется ради G14: ограничитель считает ДОЛЮ пари, закрытых через
 * «Забрать», и знаменатель обязан состоять из тех пари, где такое решение
 * существовало. `stack` и `chips` не обналичивают по определению профиля
 * (ECONOMY §9А: «профиль наглый по определению не обналичивает», и ровно
 * поэтому по нему считается G5) — их пари в знаменателе G14 делают его
 * красным по построению, а не по балансу.
 */
export const STRATEGY_CASHES_OUT: Record<StrategyName, boolean> = {
  none: false,
  single: true,
  stack: false,
  chips: false,
};

const STRATEGIES: Record<StrategyName, Strategy> = {
  none: { maxBets: 0, tier: 0, cashOutOnHurt: false, chaseChips: false },
  single: { maxBets: 1, tier: 1, cashOutOnHurt: true, chaseChips: false },
  stack: { maxBets: MAX_ACTIVE_BETS, tier: TIER_GO_BIG, cashOutOnHurt: false, chaseChips: false },
  chips: { maxBets: MAX_ACTIVE_BETS, tier: TIER_GO_BIG, cashOutOnHurt: false, chaseChips: true },
};

/**
 * Какой тир кона по карману при таком банкролле — критерий Келли (ECONOMY §7).
 *
 * Таблица §7 переведена в код один в один: при 150 фишках оптимальная ставка
 * 10.5 — «Скромно», при 350 она 24.5 — «Нормально», при 700 она 49 — «По-
 * крупному». Берётся тир, БЛИЖАЙШИЙ к доле Келли, а не наибольший, её не
 * превышающий: именно так читается таблица §7, где 24.5 названы «Нормально»
 * (25), а не «Скромно» (10).
 *
 * Считается это здесь, а не броском монеты, потому что иначе ограничитель G4
 * («верхний аппетит выбирается опытными реже 70%») меряет СОБСТВЕННУЮ
 * константу бота: зашитый шанс «По-крупному» не двигается ни от одной правки
 * экономики, и отчёт показывает его же, размытый смертями. Кошелёк —
 * единственный вход, который экономика действительно двигает.
 *
 * Второй, не менее важный эффект: заявленный «По-крупному» на кошельке в
 * сотню — это овербет в семь Келли, и наглый профиль разорялся с первых
 * комнат. Треть всех взятых пари шла коном НОЛЬ (замер до правки: 544 из
 * 1575), то есть игра, названная «Ставка», у трети ставок не включалась.
 */
const KELLY_FRACTION = 0.07;
function tierFor(wallet: number, ceiling: number): number {
  const kelly = wallet * KELLY_FRACTION;
  let best = 0;
  for (let t = 1; t <= ceiling; t++) {
    if (Math.abs(APPETITE[t] - kelly) < Math.abs(APPETITE[best] - kelly)) best = t;
  }
  return best;
}

/**
 * Прежние имена, названные в DEVLOOP §3. Остаются как есть: на них записан
 * корпус golden-эталонов и ссылаются проверки версий 0.1.0–0.3.0.
 *
 * `runner` — не профиль игрока и в замерах баланса не участвует, см. шапку
 * `RunnerBot`. Он стоит в этом списке, а не среди пар «навык:стратегия»,
 * именно потому, что осью навыка не описывается: его навык — не «мастер», а
 * «лучше любого человека», и приписать ему долю попаданий из ECONOMY §6
 * значило бы завести пятый профиль игрока, которого не существует.
 */
export const LEGACY_BOT_NAMES = ['idle', 'random', 'greedy', 'cautious', 'runner'] as const;
export type LegacyBotName = (typeof LEGACY_BOT_NAMES)[number];

/** Профиль — пара «навык:стратегия», например `master:stack`. */
export type ProfileName = `${SkillName}:${StrategyName}`;

/**
 * Известные профили. Список экспортируется, а не живёт только в типе: разбор
 * аргументов обязан назвать варианты в сообщении об ошибке, а тип во время
 * выполнения не существует. Опечатка в `--bot`, молча упавшая в `idle`, —
 * это прогон, который ничего не проверил и об этом не сказал.
 */
export const PROFILE_NAMES: readonly ProfileName[] = SKILL_NAMES.flatMap((sk) =>
  STRATEGY_NAMES.map((st): ProfileName => `${sk}:${st}`),
);

export const BOT_NAMES = [...LEGACY_BOT_NAMES, 'mixed', ...PROFILE_NAMES] as const;

export type BotName = LegacyBotName | 'mixed' | ProfileName;

export const isBotName = (s: string): s is BotName => (BOT_NAMES as readonly string[]).includes(s);

export interface Bot {
  /**
   * Чем этот бот оказался на самом деле: `median:single`, `greedy`, …
   *
   * Не то же самое, что имя в `--bot`: у смеси имя одно на прогон, а профиль
   * свой на каждый забег, и отчёт обязан называть второе. Ограничители
   * ECONOMY §13 считаются ПО ПРОФИЛЯМ (G3 про играющего на ставках, G5 про
   * наглого, G4 про опытных), и прогон, не сказавший, кем он сыгран, для них
   * бесполезен.
   */
  readonly profile: string;
  inputs(s: SimState): readonly InputFrame[];
  /**
   * Стратегия, которой сыгран забег — источник для осмысленного выбора двери
   * и товара в лавке (задача 2.5). Не задана у ботов, не описывающих профиль
   * игрока (`idle`, `random`, `greedy`, `cautious`, `runner`): им нечем
   * определить выбор, и `passDoors`/`passReward` берут для них прежнее
   * поведение — первую дверь, первый доступный товар слева направо.
   */
  readonly strategyName?: StrategyName;
}

class IdleBot implements Bot {
  readonly profile = 'idle';
  private readonly frames: InputFrame[];
  constructor(players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
  }
  inputs(): readonly InputFrame[] {
    return this.frames;
  }
}

class RandomBot implements Bot {
  readonly profile = 'random';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    // Отдельный от симуляции генератор: ввод бота — это внешний источник,
    // и он не должен сдвигать потоки самой игры.
    this.rng = createStreams(seed ^ 0x5eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      // Меняем направление не каждый тик: иначе бот дрожит на месте и
      // не доходит до краёв арены, где и живут интересные баги.
      if (s.tick % 20 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }
      // Кнопки тоже держатся, а не дёргаются каждый тик. Причин две.
      // Живой игрок удерживает огонь, и лог, где кнопка меняется 60 раз в
      // секунду, не похож ни на один настоящий забег. А ещё именно на нём
      // ломается RLE-сжатие реплея: повторов не остаётся вовсе, и эталон
      // раздувается с десятков килобайт до сотен.
      if (s.tick % 10 === 0) {
        f.buttons = 0;
        if (nextInt(this.rng, Stream.Waves, 100) < 40) f.buttons |= Btn.Fire;
        if (nextInt(this.rng, Stream.Waves, 100) < 3) f.buttons |= Btn.Dash;
      }
    }
    return this.frames;
  }
}

// ---------------------------------------------------------------------------
// Поиск целей: общий для всех ботов, которые куда-то идут
// ---------------------------------------------------------------------------

/**
 * Результат поиска отдаётся модульными переменными, а не объектом.
 *
 * Так же, как `normalize` в ядре, и по той же причине: поиск зовётся по
 * несколько раз за тик на каждого игрока, а возвращать пару чисел объектом —
 * значит класть в кучу по объекту на каждый вызов. Ядру аллокации запрещены
 * вовсе, инструментам — нет, но тысяча забегов по 54 000 тиков это тот
 * масштаб, на котором привычка видна в секундомере.
 */
let foundDX = 0;
let foundDY = 0;
let foundDist = Infinity;
/** Тип найденной угрозы (`findThreat`): от него зависит, куда от неё уходят. */
let foundType = -1;

/**
 * Точка внутри красной зоны — с запасом на радиус игрока.
 *
 * Запас обязателен: пари срывается касанием круга центром игрока, а бот
 * правит курс раз в десять тиков и за это окно проходит до полусотни единиц.
 * Цель, стоящая ровно на границе, стоила бы сорванного пари на каждом
 * подходе — то есть измеряла бы зернистость решений бота, а не то, умеет ли
 * игрок обходить зону.
 *
 * На боссовой арене зоны нет вовсе (GDD §8.1), и проверка обязана это знать:
 * иначе бот обходил бы разметку, которой на полу не существует.
 */
const RED_ZONE_SLACK = 60;
function inRedZoneAt(s: SimState, x: number, y: number): boolean {
  if (s.meta[Meta.Phase] === RunPhase.Boss) return false;
  const r = toFloat(RED_ZONE_RADIUS) + RED_ZONE_SLACK;
  return Math.hypot(x - toFloat(redZoneX(s)), y - toFloat(redZoneY(s))) < r;
}

/**
 * Ближайшая доступная игроку карта: своя персональная или общая.
 *
 * `avoidRed` — держит ли игрок «Не заходи в красную зону»: карта в зоне для
 * него не цель, а способ проиграть пари, за которое он уже заплатил кон.
 */
function findCard(
  s: SimState,
  player: number,
  px: number,
  py: number,
  avoidRed = false,
): void {
  foundDist = Infinity;
  for (let c = 0; c < MAX_CARDS; c++) {
    if (!s.kActive[c]) continue;
    if (s.kOwner[c] !== SHARED && s.kOwner[c] !== player) continue;
    const cx = toFloat(s.kX[c]);
    const cy = toFloat(s.kY[c]);
    if (avoidRed && inRedZoneAt(s, cx, cy)) continue;
    const dx = cx - px;
    const dy = cy - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/**
 * Ближайший живой враг. Целится в него любой бот, который вообще стреляет.
 *
 * `skipFuse` — держит ли игрок «Подрывника»: три врага должны погибнуть от
 * взрывов Фитилей, а застреленный Фитиль не взрывается вовсе (`killEnemy`
 * засчитывает только гибель `byBlast`). Стрелять по нему, держа это пари,
 * значит своими руками уничтожать единственное средство его выиграть.
 */
function findEnemy(s: SimState, px: number, py: number, skipFuse = false): void {
  foundDist = Infinity;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (!s.eActive[e]) continue;
    if (skipFuse && s.eType[e] === EnemyType.Fuse) continue;
    const dx = toFloat(s.eX[e]) - px;
    const dy = toFloat(s.eY[e]) - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/** Ближайшая фишка на полу. Её ищет только жадный до денег профиль. */
function findChip(s: SimState, px: number, py: number, avoidRed = false): void {
  foundDist = Infinity;
  for (let c = 0; c < MAX_CHIPS; c++) {
    if (!s.cActive[c]) continue;
    const cx = toFloat(s.cX[c]);
    const cy = toFloat(s.cY[c]);
    if (avoidRed && inRedZoneAt(s, cx, cy)) continue;
    const dx = cx - px;
    const dy = cy - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/** Держит ли игрок прямо сейчас пари с этим номером. */
function holdsBet(s: SimState, player: number, bet: number): boolean {
  for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
    const k = player * MAX_ACTIVE_BETS + n;
    if (s.aState[k] === BetState.Active && s.aBet[k] === bet) return true;
  }
  return false;
}

/**
 * Ближайшая ОБЪЯВЛЕННАЯ угроза, от которой имеет смысл уходить, и её ось.
 *
 * Именно объявленная, а не любой враг рядом: неозвученных угроз в игре нет по
 * определению (DIFFICULTY §7), и уклонение от того, что ещё не объявлено, —
 * это не навык, а суета.
 *
 * Источников четыре, а не три: таран Клина, поджёгший фитиль Фитиль,
 * объявленный выстрел Кирпича — и САМ ЛЕТЯЩИЙ СНАРЯД. Последнего здесь не
 * было, и это была не мелочь: снаряд летит 520 против 320 у игрока и живёт
 * три секунды, то есть основную часть своей жизни он и есть угроза, а Кирпич
 * в это время уже вышел из телеграфа. Замер держал сорок процентов всех
 * попаданий по мастеру за Кирпичом — то есть бот не уклонялся от того, от
 * чего человек уклоняется в первую очередь, а гейт живучести списывал это на
 * сложность игры.
 *
 * `foundDX/foundDY` — направление НА угрозу, `foundAxisX/foundAxisY` — ось, по
 * которой она движется (у неподвижной — ноль). Уходят от них по-разному: от
 * круга наружу, из коридора вбок, и знать, коридор это или круг, обязан тот,
 * кто уклоняется.
 */
let foundAxisX = 0;
let foundAxisY = 0;

function considerThreat(
  dx: number,
  dy: number,
  axisX: number,
  axisY: number,
  type: number,
): void {
  const d = Math.hypot(dx, dy);
  if (d >= foundDist) return;
  foundDist = d;
  foundDX = dx;
  foundDY = dy;
  foundAxisX = axisX;
  foundAxisY = axisY;
  foundType = type;
}

function findThreat(s: SimState, px: number, py: number): void {
  foundDist = Infinity;
  foundType = -1;
  foundAxisX = 0;
  foundAxisY = 0;

  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (!s.eActive[e]) continue;
    const phase = s.ePhase[e];
    const type = s.eType[e];
    const announced =
      (type === EnemyType.Wedge &&
        (phase === EnemyPhase.Telegraph || phase === EnemyPhase.Attack)) ||
      (type === EnemyType.Fuse && phase === EnemyPhase.Telegraph) ||
      (type === EnemyType.Brick && phase === EnemyPhase.Telegraph);
    if (!announced) continue;
    const dx = toFloat(s.eX[e]) - px;
    const dy = toFloat(s.eY[e]) - py;
    // Ось тарана — его собственная скорость, пока он летит; до рывка он ещё
    // целится, и осью служит направление на игрока, то есть то, куда он
    // полетит. Разница не косметическая: игрок, шагнувший вбок, за телеграф
    // успевает сойти с оси, и уклоняться надо от НЕЁ, а не от тела врага.
    const vx = toFloat(s.eVX[e]);
    const vy = toFloat(s.eVY[e]);
    const moving = Math.hypot(vx, vy) > 0.5 && phase === EnemyPhase.Attack;
    considerThreat(dx, dy, moving ? vx : -dx, moving ? vy : -dy, type);
  }

  // Снаряды: угроза коридором, ось — их собственный полёт. Учитываются только
  // ЛЕТЯЩИЕ В ИГРОКА: пуля, уходящая мимо, не повод бросать бой.
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (!s.bActive[b] || s.bOwner[b] !== ENEMY_OWNER) continue;
    const dx = toFloat(s.bX[b]) - px;
    const dy = toFloat(s.bY[b]) - py;
    const vx = toFloat(s.bVX[b]);
    const vy = toFloat(s.bVY[b]);
    // Скалярное произведение скорости на направление «снаряд → игрок»:
    // положительное — летит в его сторону.
    if (vx * -dx + vy * -dy <= 0) continue;
    considerThreat(dx, dy, vx, vy, THREAT_BULLET);
  }
}

/**
 * Жадный (`наглый` из SIMULATION §3): собирает все карты, играет «По-крупному»,
 * не обналичивает никогда.
 *
 * Это не «умный игрок», а явно заданная стратегия — верхняя граница ставочного
 * поведения. Ею проверяется, что экономика не разваливается от максимального
 * сборки: кон списывается за каждую карту, и упереться в пустой кошелёк такой
 * бот обязан сам, без запретов в коде.
 *
 * Руки у него по-прежнему идеальные — целится точно и жмёт огонь постоянно.
 * Это не профиль игрока, а верхняя граница, и для неё так и надо; мерить
 * профили ECONOMY §6 нужно парами «навык:стратегия», где навык задан явно.
 */
class GreedyBot implements Bot {
  readonly profile = 'greedy';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0x9eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);

      // Идём к ближайшей доступной карте: карта — это место, и весь смысл
      // жадности в том, чтобы за ней бежать.
      findCard(s, i, px, py);
      const best = foundDist;
      const cx = foundDX;
      const cy = foundDY;

      // Аппетит выставляется каждый тик, а не однажды на старте. Ядро
      // применяет его защёлкой — по ненулевым битам, и держит до следующего
      // явного нажатия, — но полагаться на то, что защёлка переживёт смену
      // комнаты или барьер старта, бот не имеет права: он объявляет свой тир
      // сам и постоянно.
      f.buttons = withAppetite(Btn.Fire, TIER_GO_BIG);
      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        // Кнопку жмём по фронту: подбор дискретен, и держать её бессмысленно.
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // Целимся в ближайшего врага: жадный не пацифист.
      findEnemy(s, px, py);
      const near = foundDist;
      const ex = near === Infinity ? 1 : foundDX;
      const ey = near === Infinity ? 0 : foundDY;
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

/**
 * Осторожный (`осторожный` из SIMULATION §3): одна ближняя карта, тир
 * «Скромно», обналичивает рано.
 *
 * Заведён ради ограничителя G14 — доля пари, закрытых через «Забрать», обязана
 * лежать в коридоре 15–35% (ECONOMY §13). Проверить его было нечем: `idle` и
 * `random` карт не берут осмысленно, а `greedy` не обналичивает никогда, и
 * доля выходила ровно нулевой при любом балансе. Ограничитель, который
 * невозможно нарушить, не ограничивает ничего.
 *
 * Тир «Скромно» — нулевой, то есть пустые биты аппетита. Это не «бот забыл
 * нажать»: нулевой тир в маске неотличим от «не нажимал», и такова маска
 * (TECH §6). Ядро трактует пустые биты как «оставить как есть», а исходное
 * состояние и есть «Скромно», — профиль сходится. Появись когда-нибудь
 * ненулевой тир по умолчанию, здесь понадобится явное нажатие, и маске
 * придётся научиться отличать одно от другого.
 */
class CautiousBot implements Bot {
  readonly profile = 'cautious';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  /** Тик, после которого пари считается «подержанным достаточно». */
  private static readonly HOLD_TICKS = 150;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0xcafe);
  }

  /** Сколько пари сейчас держит игрок и когда взято самое старое. */
  private static bets(s: SimState, player: number): { count: number; oldest: number } {
    let count = 0;
    let oldest = Infinity;
    for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
      const k = player * MAX_ACTIVE_BETS + n;
      if (s.aState[k] !== BetState.Active) continue;
      count++;
      if (s.aTakenAt[k] < oldest) oldest = s.aTakenAt[k];
    }
    return { count, oldest };
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);
      const { count, oldest } = CautiousBot.bets(s, i);

      f.buttons = Btn.Fire;

      // Одна карта за раз: держать сборку осторожный не станет. За второй он
      // не идёт вовсе, поэтому и путь в опасную зону не выбирает.
      let cx = 0;
      let cy = 0;
      let best = Infinity;
      if (count === 0) {
        findCard(s, i, px, py);
        best = foundDist;
        cx = foundDX;
        cy = foundDY;
      }

      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // «Рано» — это до того, как прогресс успел вырасти: осторожный берёт
      // синицу. Кнопка дискретна, поэтому жмём по фронту, а не удержанием.
      if (count > 0 && s.tick - oldest >= CautiousBot.HOLD_TICKS && s.tick % 6 === 0) {
        f.buttons |= Btn.CashOut;
      }

      // Целимся в ближайшего врага: осторожный — не пацифист, он просто не
      // жадный.
      findEnemy(s, px, py);
      const near = foundDist;
      const ex = near === Infinity ? 1 : foundDX;
      const ey = near === Infinity ? 0 : foundDY;
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

// ---------------------------------------------------------------------------
// Профильный бот: навык × стратегия
// ---------------------------------------------------------------------------

/** Сколько пари сейчас держит игрок. */
function activeBets(s: SimState, player: number): number {
  let count = 0;
  for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
    if (s.aState[player * MAX_ACTIVE_BETS + n] === BetState.Active) count++;
  }
  return count;
}

/**
 * Как часто бот принимает решения: раз в 10 тиков, то есть 6 Гц.
 *
 * Та же частота, что у врагов (DIFFICULTY §7), и выбрана она не за компанию.
 * Решение, пересматриваемое каждый тик, даёт ввод, меняющийся 60 раз в
 * секунду: он не похож ни на один живой забег и ломает RLE-сжатие реплея —
 * повторов не остаётся вовсе, и эталон раздувается с десятков килобайт до
 * сотен. Заодно частота задаёт зернистость доли стрельбы: 0.5 — это
 * полсекунды с зажатым курком и полсекунды без, а не мерцание.
 */
const DECIDE_EVERY = 10;

/**
 * Разброс промаха: ±10°.
 *
 * Числа в документах нет, и оно выводится, а не назначается. Враг радиусом 20
 * плюс радиус пули 6 на типичной дистанции боя в 400 единиц занимает около
 * трёх градусов; промах обязан быть промахом, а не «почти попал», поэтому
 * конус втрое шире — на 400 единицах пуля уходит мимо на 70. Обратная сторона
 * названа прямо: в упор (ближе ~150 единиц) промахнуться этим механизмом
 * нельзя, и доля попаданий у бота растёт вблизи так же, как у человека.
 */
const MISS_CONE = Math.round((10 * ANGLE_FULL) / 360);

/**
 * С какого расстояния бот вообще думает уходить от объявленной угрозы.
 *
 * Выведено из Фитиля: он поджигает фитиль на 120 и взрывается радиусом 140
 * (DIFFICULTY §7), то есть на 260 единицах угроза ещё достаёт того, кто стоит
 * на месте. Всё, что дальше, — не уклонение, а бегство от арены.
 */
const DODGE_RANGE = 260;

/** Псевдотип угрозы «летящий снаряд»: типов врагов он не занимает. */
const THREAT_BULLET = -2;

/**
 * На сколько единиц вперёд бот смотрит, проверяя, не уводит ли уклонение в
 * красную зону: окно решений — десять тиков, за них игрок проходит
 * 320/60×10 ≈ 53 единицы, и заглядывать дальше значит отказываться от
 * направления из-за того, что случится через три решения.
 */
const DODGE_STEP = 60;

/** ВРЕМЕННЫЙ переключатель эксперимента: запасной ход — по прямой от угрозы. */

class ProfileBot implements Bot {
  readonly profile: string;
  readonly strategyName: StrategyName;
  private readonly frames: InputFrame[];
  private readonly rng: RngState;
  private readonly skill: Skill;
  private readonly strategy: Strategy;

  /** Решения, принятые на текущее окно: держатся все DECIDE_EVERY тиков. */
  private readonly firing: Uint8Array;
  private readonly evading: Uint8Array;
  private readonly dashing: Uint8Array;
  private readonly aimError: Int32Array;

  /** Сердец в прошлом тике: по их убыли `single` решает соскочить. */
  private readonly hearts: Int32Array;
  private readonly bailing: Uint8Array;


  constructor(skill: SkillName, strategy: StrategyName, seed: number, players: number) {
    this.profile = `${skill}:${strategy}`;
    this.strategyName = strategy;
    this.skill = SKILLS[skill];
    this.strategy = STRATEGIES[strategy];
    this.frames = Array.from({ length: players }, makeFrame);
    // Свой генератор, и он же разный у разных профилей: два профиля на одном
    // сиде обязаны отличаться поведением, а не только числами в таблице.
    const salt = (SKILL_NAMES.indexOf(skill) << 8) ^ (STRATEGY_NAMES.indexOf(strategy) << 12);
    this.rng = createStreams(seed ^ 0xb07 ^ salt);
    this.firing = new Uint8Array(players);
    this.evading = new Uint8Array(players);
    this.dashing = new Uint8Array(players);
    this.aimError = new Int32Array(players);
    this.hearts = new Int32Array(players);
    this.bailing = new Uint8Array(players);
    this.hearts.fill(PLAYER.startHearts);
  }

  /** Бросок на сотню: `pct` процентов за «да». */
  private roll(pct: number, stream: Stream = Stream.Waves): boolean {
    return nextInt(this.rng, stream, 100) < pct;
  }

  private decide(player: number): void {
    this.firing[player] = this.roll(this.skill.firePct) ? 1 : 0;
    this.evading[player] = this.roll(this.skill.dodgePct) ? 1 : 0;
    // Рывок — часть уклонения, а не отдельная кнопка (см. `move()`): второй
    // независимый бросок той же `dodgePct` возводил её в квадрат для реального
    // шанса дёрнуться (30% novice превращались в 9%), и этот файл сам себе
    // противоречил — комментарий у `Btn.Dash` ниже уже объявлял решение другим.
    this.dashing[player] = this.evading[player];
    // Точность — это доля выстрелов, идущих точно: остальные уходят в конус.
    // Ошибка держится всё окно, а не пересчитывается каждый тик, иначе она
    // усредняется в ноль и точность перестаёт значить что-либо.
    this.aimError[player] = this.roll(this.skill.aimPct)
      ? 0
      : nextInt(this.rng, Stream.Waves, MISS_CONE * 2 + 1) - MISS_CONE;
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      if (s.tick % DECIDE_EVERY === 0) this.decide(i);

      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);
      const held = activeBets(s, i);

      // Аппетит объявляется каждый тик: защёлка ядра держит его до следующего
      // явного нажатия, но переживёт ли она смену комнаты — не дело бота.
      // Тир — по кошельку (`tierFor`), потолок — по стратегии: «наглый»
      // остаётся наглым, но не ставит половину банкролла на одну карту.
      f.buttons = withAppetite(
        this.firing[i] ? Btn.Fire : 0,
        tierFor(s.pChips[i], this.strategy.tier),
      );

      // Потерянное сердце — повод соскочить у умеренного профиля: «обналичивает
      // при потере сердца» (SIMULATION §3). Флаг, а не мгновенное нажатие,
      // потому что кнопка дискретна и жать её надо по фронту.
      if (s.pHearts[i] < this.hearts[i] && this.strategy.cashOutOnHurt) this.bailing[i] = 1;
      this.hearts[i] = s.pHearts[i];
      if (held === 0) this.bailing[i] = 0;
      if (this.bailing[i] && s.tick % 6 === 0) f.buttons |= Btn.CashOut;

      /*
       * Ставка Крупье: решение принимает СТРАТЕГИЯ, а не случай.
       *
       * Без этого ограничитель G12 нечем считать: механика есть, а согласиться
       * на неё в Monte-Carlo некому, и отчёт показывал бы ноль ставок Крупье за
       * тысячу забегов — то есть «ожидание в коридоре» по пустой выборке.
       *
       * Играющий на ставках принимает: ожидание для него положительное
       * (ECONOMY §10А), и отказ был бы игрой хуже собственного профиля. Тот,
       * кто карт не берёт вовсе (`none`), отказывается — иначе «осторожный»
       * оказался бы игроком, который не рискует, но ставку у Крупье берёт.
       */
      if (held < MAX_ACTIVE_BETS && aceCardAt(s) >= 0 && s.tick % 4 === 0) {
        f.buttons |= this.strategy.maxBets > 0 ? Btn.Confirm : Btn.Cancel;
      }

      this.move(s, i, f, px, py, held);
      this.aim(s, i, f, px, py);
    }
    return this.frames;
  }

  /**
   * Куда идти. Приоритет один и тот же у всех профилей, меняются только
   * пороги: сначала спасать шкуру, потом брать деньги, потом собирать сдачу.
   *
   * Взятое пари меняет ВСЕ три шага, а не добавляет четвёртый: держащий «Не
   * заходи в красную зону» не бежит за картой в зону, держащий «Собери все
   * фишки» гонится за фишками независимо от стратегии (иначе пари срывается
   * первой же истёкшей фишкой — `combat.ts`), держащий «Без рывка» не жмёт
   * рывок даже спасаясь. Пока этого не было, вероятность каждого пари меряла
   * не игру, а совпадение: «Без рывка» выигрывалось в 4.4% случаев при
   * целевых 55%, «Подрывник» — в 7.5% при целевых 45%.
   */
  private move(s: SimState, i: number, f: InputFrame, px: number, py: number, held: number): void {
    const avoidRed = holdsBet(s, i, BetId.NoRedZone);
    const noDash = holdsBet(s, i, BetId.NoDash);

    if (this.evading[i]) {
      findThreat(s, px, py);
      if (foundDist < DODGE_RANGE) {
        this.flee(s, i, f, px, py, avoidRed, noDash);
        return;
      }
    }

    // Стоя в красной зоне с пари на неё, игрок уже проигрывает — выйти важнее
    // любой карты и любой фишки.
    if (avoidRed && inRedZoneAt(s, px, py)) {
      const dx = px - toFloat(redZoneX(s));
      const dy = py - toFloat(redZoneY(s));
      const len = Math.hypot(dx, dy) || 1;
      f.moveX = fromFloat(dx / len);
      f.moveY = fromFloat(dy / len);
      return;
    }

    if (held < this.strategy.maxBets) {
      findCard(s, i, px, py, avoidRed);
      if (foundDist < Infinity) {
        const len = foundDist || 1;
        f.moveX = fromFloat(foundDX / len);
        f.moveY = fromFloat(foundDY / len);
        if (foundDist < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
        return;
      }
    }

    if (this.strategy.chaseChips || holdsBet(s, i, BetId.AllChips)) {
      findChip(s, px, py, avoidRed);
      if (foundDist < Infinity) {
        const len = foundDist || 1;
        f.moveX = fromFloat(foundDX / len);
        f.moveY = fromFloat(foundDY / len);
        return;
      }
    }

    // Идти некуда — бродим. Не стоим: неподвижная мишень не проверяет ни
    // навигацию врагов, ни спавн, ни достижимость безопасной точки.
    if (s.tick % 30 === 0) {
      f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
    }
  }

  /**
   * Уклонение: от снаряда шаг ВБОК, от врага — НАЗАД.
   *
   * Разделение не стилистическое, оно замерено. Прежний бот уходил по прямой
   * от всего подряд и не уклонялся от летящих снарядов вовсе (их не было в
   * `findThreat`) — сорок процентов попаданий по мастеру приходили от
   * Кирпича, то есть от того, от чего человек уклоняется первым делом.
   *
   *   | что делает бот                | попаданий за комнату, `master:none` |
   *   | ----------------------------- | ----------------------------------- |
   *   | по прямой от всего (как было) | 0.97                                |
   *   | вбок от всего                 | 0.85                                |
   *   | **вбок от снаряда, назад от врага** | **0.74**                      |
   *
   * И это не случайность выборки, а разная физика двух угроз. Снаряд летит
   * 520 против 320 у игрока и не перецеливается: убежать от него нельзя,
   * сойти с его линии — можно, и цена шага не зависит от его скорости. Клин и
   * Фитиль, наоборот, ПРЕСЛЕДУЮТ: шаг вбок оставляет игрока на той же
   * дистанции, и следующий таран объявляется через секунду, а отход выводит
   * из `aimRange` (560) и разрывает саму цепочку.
   *
   * Медиана дошедшей комнаты у `master:none` при этом уезжает с пятой на
   * восьмую — то есть до починки половина всей разницы между «мастер» и
   * «новичок» тонула в слепоте бота к снарядам.
   */
  private flee(
    s: SimState,
    i: number,
    f: InputFrame,
    px: number,
    py: number,
    avoidRed: boolean,
    noDash: boolean,
  ): void {
    const threatX = foundDX;
    const threatY = foundDY;
    const type = foundType;
    const len = foundDist || 1;

    let mx: number;
    let my: number;
    if (type !== THREAT_BULLET) {
      // Клин и Фитиль ПРЕСЛЕДУЮТ: от них уходят назад. Фитиль вдобавок
      // накрывает кругом (поджиг на 120, взрыв радиусом 140), и наружу из
      // круга ведёт ровно одно направление — от его центра.
      mx = -threatX / len;
      my = -threatY / len;
    } else {
      // Снаряд — угроза КОРИДОРОМ вдоль своего полёта, и летит он 520 против
      // 320 у игрока: убежать нельзя, сойти с линии можно, и цена шага не
      // зависит от того, насколько снаряд быстрее.
      const alen = Math.hypot(foundAxisX, foundAxisY) || 1;
      let sx = -foundAxisY / alen;
      let sy = foundAxisX / alen;
      // Сторона выбирается та, где больше места до края арены: шаг вбок в
      // стену — это стояние под ударом.
      const w = toFloat(s.arenaW);
      const h = toFloat(s.arenaH);
      const probe = 200;
      const room = (dx: number, dy: number): number =>
        Math.min(px + dx * probe, w - (px + dx * probe), py + dy * probe, h - (py + dy * probe));
      if (room(-sx, -sy) > room(sx, sy)) {
        sx = -sx;
        sy = -sy;
      }
      mx = sx;
      my = sy;
    }

    // Спасаться в красную зону, держа пари на неё, — значит менять сердце на
    // проигранный кон. Направление отклоняется наружу ровно настолько, чтобы
    // уйти от угрозы мимо зоны, а не встать под удар ради разметки.
    if (avoidRed && inRedZoneAt(s, px + mx * DODGE_STEP, py + my * DODGE_STEP)) {
      const ox = px - toFloat(redZoneX(s));
      const oy = py - toFloat(redZoneY(s));
      const olen = Math.hypot(ox, oy) || 1;
      mx += ox / olen;
      my += oy / olen;
    }

    const mlen = Math.hypot(mx, my) || 1;
    f.moveX = fromFloat(mx / mlen);
    f.moveY = fromFloat(my / mlen);
    // Рывок — часть уклонения, а не отдельная кнопка: он и неуязвимость даёт,
    // и дистанцию рвёт. Кулдаун проверяем сами, чтобы не жать впустую; с пари
    // «Без рывка» не жмём вовсе — сорвать своё же пари ради шага в сторону
    // значит играть хуже собственного профиля.
    if (!noDash && this.dashing[i] && s.tick >= s.pDashReady[i]) f.buttons |= Btn.Dash;
  }

  /**
   * Куда целиться. Ближайший враг плюс ошибка навыка, повёрнутая в
   * фиксированной точке: тригонометрия берётся из таблиц ядра, а не из
   * `Math`, — IEEE-синус не обязан совпадать между движками, а ввод бота
   * уезжает в golden-эталоны.
   */
  private aim(s: SimState, i: number, f: InputFrame, px: number, py: number): void {
    // «Подрывник» требует трёх врагов, убитых взрывом Фитиля; застреленный
    // Фитиль не взрывается. Держа это пари, по Фитилям не стреляют — иначе
    // игрок своими руками уничтожает единственное средство выиграть.
    findEnemy(s, px, py, holdsBet(s, i, BetId.Demolitionist));
    if (foundDist === Infinity) {
      f.aimX = fromInt(1);
      f.aimY = 0;
      return;
    }

    normalize(fromFloat(foundDX), fromFloat(foundDY));
    let dx = normX;
    let dy = normY;

    const err = this.aimError[i];
    if (err !== 0) {
      const c = cos(err & (ANGLE_FULL - 1));
      const sn = sin(err & (ANGLE_FULL - 1));
      const rx = sub(mul(dx, c), mul(dy, sn));
      const ry = add(mul(dx, sn), mul(dy, c));
      dx = rx;
      dy = ry;
    }

    f.aimX = dx;
    f.aimY = dy;
  }
}

// ---------------------------------------------------------------------------
// Проходчик: бот, доигрывающий этаж до конца
// ---------------------------------------------------------------------------

/**
 * На какой дистанции проходчик держит ближайшего врага.
 *
 * Пуля живёт 1.2 с при скорости 900, то есть достаёт на 1080 единиц — больше
 * половины арены. Значит подходить не нужно вовсе, и вся дистанция выбирается
 * из выживания: 420 — это два тарана Клина (490 за рывок) минус то, что он
 * успевает пройти шагом, и с такого расстояния объявленный таран уводится
 * шагом вбок, без рывка.
 */
const KEEP_RANGE = 420;

/** Ближе этого проходчик отступает, даже если никто ничего не объявил. */
const TOO_CLOSE = 260;

/**
 * Дистанция уверенного огня: до неё проходчик идёт сам, если волна не
 * добита, а не ждёт, пока враг подойдёт.
 *
 * `KEEP_RANGE` держит дистанцию от того, кто идёт на игрока сам — таран,
 * снаряд. Против пассивного или далёкого врага (тот же Кирпич, отходящий,
 * чтобы стрелять издали) держать 420 бессмысленно: тот, кто не приближается,
 * с этой дистанции просто не добивается, а комната не считается зачищенной,
 * пока жив хоть один. `ENGAGE_RANGE` меньше `TOO_CLOSE` больше не может — иначе
 * подход сам включал бы отступление, — и меньше `KEEP_RANGE`, чтобы охота
 * заканчивалась раньше, чем гистерезис снова потребует держаться подальше.
 */
const ENGAGE_RANGE = 300;

/**
 * Запас к расстоянию до безопасной точки, при котором тратится рывок.
 *
 * Рывок — не «кнопка паники»: он даёт неуязвимость на 14 тиков и 240 единиц
 * хода, но перезаряжается 72 тика. Потраченный на угрозу, от которой уходит
 * шаг, он не готов к той, от которой не уходит.
 */
const DASH_IF_FARTHER = 200;

/**
 * Проходчик — служебный боец, а не игрок и, вопреки имени, НЕ средство
 * пройти этаж.
 *
 * Задуман он был именно как проходчик записи: прогон, который ДОХОДИТ ДО
 * КОНЦА ЭТАЖА, чтобы golden-эталоны видели дверь, лавку, плату и босса, а не
 * только первую комнату (замер, с которого всё началось: все двадцать
 * эталонов `random` гибли в комнате 1 между тиками 802 и 1711, а лучший из
 * шестнадцати профилей «навык:стратегия» не добирался до пятой). Замысел не
 * состоялся: три независимые причины простоя починены по очереди —
 * уклонение, никогда не уступавшее бою, отсутствие добивания волны, слепота
 * к перекрытой линии огня, — и после всех трёх idleShare застрял на 95–98%.
 * Слоёв оказалось больше, чем времени на них, и дальше этот путь не ведётся
 * (см. запись 0.3.11 в `golden.ts`).
 *
 * Golden-корпус эту дыру закрыл ДРУГИМ путём — записью с подготовленного
 * состояния (`Golden.setup`, `packages/tools/src/scenario.ts`), а не этим
 * ботом. Класс оставлен не как заброшенный код, а как рабочий инструмент:
 * уклоняется он не эвристикой, а той самой проверкой, которой меряется
 * ограничитель D4, — `findSafePoint` отвечает, куда игрок УСПЕВАЕТ уйти от
 * всех объявленных угроз, и проходчик идёт туда. Для юнит- и
 * scenario-тестов, которым нужен участник боя, честно уклоняющийся от
 * объявленных угроз и не проходящий этаж целиком заведомо не обязанный, он
 * годен и годнее прежних ботов, круживших ОТ угрозы по прямой — то есть
 * остававшихся в коридоре тарана, летящего вдвое быстрее их самих.
 *
 * Профилем игрока он не является и в замерах баланса участвовать не должен:
 * человек так не играет. Ограничители ECONOMY §13 считаются по `mixed` и по
 * парам «навык:стратегия» — там ему места нет, и SIMULATION §3 говорит об
 * этом прямо.
 */
class RunnerBot implements Bot {
  readonly profile = 'runner';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  /**
   * Пари он берёт, и это не жадность: эталон, обходящий карты стороной, не
   * покрывал бы половину состояния — ни активных пари, ни расчёта, ни Крупье.
   * Тир средний: «По-крупному» на пустом кошельке не отличается от «Скромно»,
   * а разорившийся проходчик не купит в лавке ничего.
   */
  private static readonly TIER = 1;

  /**
   * Отступает ли игрок прямо сейчас. Флаг, а не пересчёт с нуля каждый тик:
   * «уклоняюсь, пока угроза ближе TOO_CLOSE, атакую, пока дальше KEEP_RANGE»
   * — гистерезис, а не единый список приоритетов, которым отступление было
   * раньше. Единый список ловил игрока в петле: стоит появиться в поле
   * зрения хоть одной объявленной угрозе — и весь тик уходит в `findSafePoint`,
   * а не в цель или карту, даже если та угроза далеко и торопиться некуда. Раз
   * начав отступать, бот больше не подходил стрелять, комната переставала
   * терять врагов, и `RoomThreat` вставал намертво — не из-за смерти, а из-за
   * того, что осторожность никогда не уступала место бою.
   *
   * Зазор между порогами — не то же самое, что зазор внутри `findThreat`:
   * дрожание на границе одного числа переключало бы режим по нескольку раз
   * за тик из-за шага противника.
   */
  private readonly retreating: Uint8Array;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0x0f100d);
    this.retreating = new Uint8Array(players);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      f.buttons = withAppetite(Btn.Fire, RunnerBot.TIER);
      f.moveX = 0;
      f.moveY = 0;

      if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);

      this.aim(s, f, px, py);
      this.act(s, i, f, px, py);
      this.move(s, i, f, px, py);
    }
    return this.frames;
  }

  /**
   * Куда идти. Режим переключается гистерезисом (см. `retreating`), внутри
   * режима — свой порядок: в отступлении сначала спастись, в бою сначала
   * взять карту, потом добить волну, потом собрать сдачу, потом держать
   * дистанцию.
   *
   * Охота за врагом стоит впереди фишек не случайно: фишка никуда не
   * убежит, а зачистка волны — это то единственное, ради чего проходчик
   * вообще существует (см. шапку класса). Гнаться за фишкой, пока жив
   * последний враг волны, — значит платить временем комнаты за деньги,
   * которые эталону не нужны ради самих себя.
   *
   * Порядок в бою не переставляется: карта, взятая под объявленный таран,
   * стоит сердца, а сердец три на весь забег и добавить их можно только в
   * лавке.
   */
  private move(s: SimState, i: number, f: InputFrame, px: number, py: number): void {
    findThreat(s, px, py);
    const threatDist = foundDist;

    if (this.retreating[i]) {
      if (threatDist > KEEP_RANGE) this.retreating[i] = 0;
    } else if (threatDist < TOO_CLOSE) {
      this.retreating[i] = 1;
    }

    if (this.retreating[i]) {
      const safe = findSafePoint(s, i);
      if (safe.horizon !== Infinity) {
        const dx = safe.x - px;
        const dy = safe.y - py;
        const d = Math.hypot(dx, dy);
        if (d > 1) {
          f.moveX = fromFloat(dx / d);
          f.moveY = fromFloat(dy / d);
          // Рывок — на дальнюю точку и только на готовом кулдауне: он и
          // неуязвимость, и скорость, но потраченный впустую он не готов к
          // следующей угрозе.
          if (d > DASH_IF_FARTHER && s.tick >= s.pDashReady[i]) f.buttons |= Btn.Dash;
        }
        return;
      }
      // D4 гарантирует выход только от ОБЪЯВЛЕННОЙ угрозы: гистерезис мог
      // включить отступление раньше, чем что-то объявили (порог TOO_CLOSE —
      // про приближение, а не про телеграф). Тогда идти уже некуда в смысле
      // D4, и отступление доигрывается тем же кодом, что и бой ниже.
    }

    // В бою — карта первой: пари двигают всё остальное состояние, ради
    // которого эталон и пишется.
    findCard(s, i, px, py);
    if (foundDist < Infinity && activeBets(s, i) < MAX_ACTIVE_BETS) {
      const len = foundDist || 1;
      f.moveX = fromFloat(foundDX / len);
      f.moveY = fromFloat(foundDY / len);
      return;
    }

    findEnemy(s, px, py);
    const enemy = foundDist;
    const enemyX = foundDX;
    const enemyY = foundDY;

    // Волна не добита, и ближайший враг дальше дистанции уверенного огня —
    // идём к нему сами. `KEEP_RANGE` ниже держит расстояние от того, кто сам
    // идёт на игрока; тот, кто не идёт (отстал, отходит, ещё не заметил),
    // с той дистанции не добивается никогда, и комната стоит.
    if (enemy < Infinity && enemy > ENGAGE_RANGE) {
      const len = enemy || 1;
      f.moveX = fromFloat(enemyX / len);
      f.moveY = fromFloat(enemyY / len);
      return;
    }

    // Фишки собираются, когда добивать некого: они и есть кошелёк, а
    // кошелёк — это лавка и плата заведению, то есть ровно те экраны, до
    // которых эталон обязан дожить.
    findChip(s, px, py);
    if (foundDist < Infinity) {
      const len = foundDist || 1;
      f.moveX = fromFloat(foundDX / len);
      f.moveY = fromFloat(foundDY / len);
      return;
    }

    // Идти некуда — бродим, а не стоим: неподвижная мишень не проверяет ни
    // навигацию врагов, ни спавн, ни достижимость безопасной точки.
    if (s.tick % 30 === 0) {
      f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
    }
  }

  /** Кнопки, которые не про движение: подбор карты и ответ Крупье. */
  private act(s: SimState, i: number, f: InputFrame, px: number, py: number): void {
    findCard(s, i, px, py);
    if (foundDist < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
    // Ставку Крупье принимает: ожидание по ней положительное (ECONOMY §10А), и
    // отказ был бы игрой хуже собственного профиля.
    if (aceCardAt(s) >= 0 && s.tick % 4 === 0) f.buttons |= Btn.Confirm;
  }

  /**
   * Куда целиться: в босса, если он на арене, иначе в ближайшего врага.
   *
   * Босс не лежит в пуле врагов (`stepHits` в `boss.ts` проверяет попадания
   * отдельно), поэтому целиться в него надо отдельно — бот, ищущий только
   * `eActive`, стрелял бы в свиту и не снял бы с босса ни очка.
   */
  private aim(s: SimState, f: InputFrame, px: number, py: number): void {
    let dx: number;
    let dy: number;
    if (s.meta[Meta.BossMaxHP] !== 0) {
      dx = toFloat(wheelX(s)) - px;
      dy = toFloat(wheelY(s)) - py;
    } else {
      findEnemy(s, px, py);
      if (foundDist === Infinity) {
        f.aimX = fromInt(1);
        f.aimY = 0;
        return;
      }
      dx = foundDX;
      dy = foundDY;
    }
    const len = Math.hypot(dx, dy) || 1;
    f.aimX = fromFloat(dx / len);
    f.aimY = fromFloat(dy / len);
  }
}

// ---------------------------------------------------------------------------
// Смесь профилей
// ---------------------------------------------------------------------------

/**
 * Доли профилей в смеси, в процентах. Сумма каждой оси — ровно сто.
 *
 * Чисел этих в документах не было: ECONOMY §6 описывает четыре профиля, но не
 * говорит, сколько кого за столом. Они записаны здесь и продублированы в
 * SIMULATION §3 как гипотеза о плейтест-аудитории — та самая, которую
 * телеметрия 0.11.0 заменит фактом (SIMULATION §7). Смысл долей:
 *
 *   — навык центрирован на медианном, потому что от него посчитана вся
 *     сложность; мастер редок — это верхушка таблиц, а не средний игрок;
 *   — стратегия `none` в смесь НЕ входит вовсе, и это не забывчивость. G6
 *     требует, чтобы забегов с нулём взятых пари было меньше 5%, а `none`
 *     не берёт их никогда: любая заметная доля такого профиля валила бы
 *     ограничитель составом смеси, а не балансом игры. Трус прогоняется
 *     отдельным `--bot novice:none`, ради G6 он и заведён.
 */
const SKILL_MIX: readonly (readonly [SkillName, number])[] = [
  ['novice', 25],
  ['median', 40],
  ['veteran', 25],
  ['master', 10],
];

const STRATEGY_MIX: readonly (readonly [StrategyName, number])[] = [
  ['single', 45],
  ['stack', 35],
  ['chips', 20],
];

function pick<T>(mix: readonly (readonly [T, number])[], roll: number): T {
  let acc = 0;
  for (const [name, weight] of mix) {
    acc += weight;
    if (roll < acc) return name;
  }
  return mix[mix.length - 1][0];
}

/**
 * Профиль смеси для сида. Чистая функция: один сид — один профиль, всегда.
 *
 * Смесь разыгрывается НА ЗАБЕГ, а не на тик и не на игрока: `--runs 1000
 * --bot mixed` — это тысяча разных людей за одним столом по очереди, и
 * ограничители считаются по тому, кем сыгран каждый забег. Розыгрыш на каждом
 * тике дал бы одного шизофреника вместо тысячи игроков.
 */
export function mixedProfile(seed: number): ProfileName {
  const rng = createStreams(seed ^ 0xb1e5);
  const skill = pick(SKILL_MIX, nextInt(rng, Stream.Waves, 100));
  const strategy = pick(STRATEGY_MIX, nextInt(rng, Stream.Waves, 100));
  return `${skill}:${strategy}`;
}

export function makeBot(name: BotName, seed: number, players: number): Bot {
  const bot = makeRawBot(name, seed, players);
  // Экран двери проходится одинаково всеми, поэтому обёрнут здесь один раз, а
  // не продублирован в шести реализациях `inputs`. Профиль пробрасывается как
  // есть: обёртка не меняет того, кем сыгран забег, а отчёт спрашивает именно
  // это. Стратегия пробрасывается тем же путём — ею выбирается дверь и товар
  // в лавке (задача 2.5); ботам без профиля передавать нечего, и они получают
  // `undefined`, то есть прежнее поведение.
  return {
    profile: bot.profile,
    ...(bot.strategyName !== undefined ? { strategyName: bot.strategyName } : {}),
    inputs: (s) => passReward(s, passDoors(s, bot.inputs(s), bot.strategyName), bot.strategyName),
  };
}

function makeRawBot(name: BotName, seed: number, players: number): Bot {
  switch (name) {
    case 'greedy':
      return new GreedyBot(seed, players);
    case 'cautious':
      return new CautiousBot(seed, players);
    case 'random':
      return new RandomBot(seed, players);
    case 'runner':
      return new RunnerBot(seed, players);
    case 'idle':
      return new IdleBot(players);
    case 'mixed': {
      const [skill, strategy] = mixedProfile(seed).split(':') as [SkillName, StrategyName];
      return new ProfileBot(skill, strategy, seed, players);
    }
    default: {
      const [skill, strategy] = name.split(':') as [SkillName, StrategyName];
      return new ProfileBot(skill, strategy, seed, players);
    }
  }
}

/**
 * Порядок предпочтения дверей по стратегии (ECONOMY §6, задача 2.5).
 *
 * Числа в документах нет — ECONOMY описывает профили результатом («осторожный
 * позволяет себе один апгрейд за забег», «наглый берёт сборку на кону 50»), а не
 * порядком выбора двери, — и порядок здесь выведен из этого результата, а не
 * назначен произвольно:
 *
 *   — **Жирный бой** удваивает выплату комнаты и добавляет карту (GDD §5), то
 *     есть повышает и доход, и число ставок разом. Это ровно то, подо что
 *     `stack`/`chips` держат максимальную сборку ставок (ECONOMY §9) — они
 *     ставят её первой. `none` не берёт карт вовсе, и лишняя карта ему не
 *     нужна ни разу — жирный бой для него не риск, а бой без всякой отдачи,
 *     и он ставит его последним; `single` держит одно пари и не гонится за
 *     дисперсией — жирный бой ему нейтрален, а не желанен.
 *   — **Лавка и Дар** — единственный способ купить силу. `none` может
 *     позволить себе один апгрейд за весь забег (ECONOМY §6) и обязан ловить
 *     каждый шанс, поэтому ставит их первыми; `single`, у которого апгрейдов
 *     больше (три-четыре за забег), тоже предпочитает их обычному бою, но не
 *     так безусловно.
 */
const DOOR_PRIORITY: Record<StrategyName, readonly number[]> = {
  none: [DoorType.Shop, DoorType.Gift, DoorType.Fight, DoorType.DebtPit, DoorType.Fat],
  single: [DoorType.Gift, DoorType.Shop, DoorType.Fight, DoorType.DebtPit, DoorType.Fat],
  stack: [DoorType.Fat, DoorType.Fight, DoorType.Shop, DoorType.Gift, DoorType.DebtPit],
  chips: [DoorType.Fat, DoorType.Fight, DoorType.Shop, DoorType.Gift, DoorType.DebtPit],
};

/** Слот из предложенных дверей, ближе всего к вершине приоритета стратегии. */
function pickDoorSlot(s: SimState, strategyName: StrategyName): number {
  for (const type of DOOR_PRIORITY[strategyName]) {
    for (let i = 0; i < MAX_DOORS; i++) {
      if (s.doorType[i] === type) return i;
    }
  }
  return 0;
}

/**
 * Экран двери: бот обязан его пройти, иначе headless-прогон встаёт навсегда.
 *
 * Дверь ждёт игрока, а не часов — это несущее правило экрана (UX §3), и
 * менять его ради ботов нельзя: дверь, закрывающаяся сама, превращает выбор
 * в реакцию. Значит проходить её должен тот, кто изображает игрока.
 *
 * Обёртка общая на всех ботов, а не метод в каждом: экран одинаков для всех,
 * а забыть его в одном из шести означало бы зависший прогон ровно на том
 * профиле, которым реже пользуются. Первый же `npm run safety` после дверей
 * висел бы пять тысяч тиков молча.
 *
 * Выбор двери — предмет СТРАТЕГИИ (задача 2.5): бот без профиля (`strategyName`
 * не задан) по-прежнему берёт первую дверь — это ботов, не изображающих игрока
 * (idle, random, greedy, cautious, runner), не касается ни один ограничитель
 * ECONOMY §13. Профильный бот двигает фокус к слоту, который меньше всего
 * противоречит стратегии, и лишь затем подтверждает — кнопка нажимается через
 * тик, потому что экран читает нажатия по фронту, а держать её — значит
 * нажать один раз.
 */
export function passDoors(
  s: SimState,
  frames: readonly InputFrame[],
  strategyName?: StrategyName,
): readonly InputFrame[] {
  if (s.meta[Meta.Phase] !== RunPhase.Door) return frames;

  const focus = s.meta[Meta.DoorPick];
  const target = strategyName ? pickDoorSlot(s, strategyName) : 0;

  let button: number;
  // Из пустого фокуса «влево» ставит крайний левый элемент (`moveFocus`), и
  // бот начинает оттуда: раньше он жал «вправо» и попадал на крайний правый,
  // а до нужной двери шёл назад лишними кадрами.
  if (focus < 0) button = Btn.NavLeft;
  else if (focus < target) button = Btn.NavRight;
  else if (focus > target) button = Btn.NavLeft;
  else button = Btn.Confirm;

  const out = frames.map((f) => ({ ...f, buttons: 0 }));
  if (s.tick % 2 === 0) out[0].buttons = button;
  return out;
}

/**
 * Порядок предпочтения эффектов на прилавке по стратегии (ECONOMY §5, задача
 * 2.5). Каждая строка — не выдумка, а причина, записанная в таблице апгрейдов
 * ECONOMY §5, применённая к тому, чем отличается стратегия от остальных трёх:
 *
 *   — `none`: сердце — «единственная покупка, работающая после ошибки, а не
 *     до неё» (ECONOMY §5), и осторожный, копящий на единственный апгрейд за
 *     забег, берёт именно её. Кулдаун рывка — следующий: рывок «главный
 *     инструмент выживания» у того, кто не лечится ставками.
 *   — `single`: одно пари, обналичивает при потере сердца (`cashOutOnHurt`) —
 *     то есть боится урона больше прочих. Урон пули «прямее всех двигает
 *     время убийства», то есть время под угрозой (ECONOMY §5) — ему первым.
 *   — `stack`: держит сборку ставок и не обналичивает никогда — карты его не
 *     отпускают до расчёта, поэтому не терять кулдаун важнее, чем у прочих:
 *     рывок «главный инструмент выживания» (ECONOMY §5) стоит первым, сердце
 *     вторым.
 *   — `chips`: ходит за фишками на полу — «Магнит» и «Дроп» прямо умножают то,
 *     ради чего профиль заведён (ECONOMY §4), и стоят первыми только у него.
 */
const SHOP_PRIORITY: Record<StrategyName, readonly UpgradeEffect[]> = {
  none: [
    UpgradeEffect.Heart,
    UpgradeEffect.DashCooldown,
    UpgradeEffect.Damage,
    UpgradeEffect.Magnet,
    UpgradeEffect.Drop,
    UpgradeEffect.Speed,
  ],
  single: [
    UpgradeEffect.Damage,
    UpgradeEffect.Heart,
    UpgradeEffect.DashCooldown,
    UpgradeEffect.Speed,
    UpgradeEffect.Magnet,
    UpgradeEffect.Drop,
  ],
  stack: [
    UpgradeEffect.DashCooldown,
    UpgradeEffect.Heart,
    UpgradeEffect.Damage,
    UpgradeEffect.Speed,
    UpgradeEffect.Magnet,
    UpgradeEffect.Drop,
  ],
  chips: [
    UpgradeEffect.Magnet,
    UpgradeEffect.Drop,
    UpgradeEffect.Damage,
    UpgradeEffect.DashCooldown,
    UpgradeEffect.Heart,
    UpgradeEffect.Speed,
  ],
};

/**
 * Слот прилавка, ближе всего к вершине приоритета стратегии и по карману.
 * Минус один — приоритетного и доступного нет, вызывающий берёт прежнее
 * поведение (первый доступный слева направо).
 */
function pickShopSlot(s: SimState, strategyName: StrategyName): number {
  for (const effect of SHOP_PRIORITY[strategyName]) {
    for (let i = 0; i < SHOP_SLOTS; i++) {
      const item = s.shopItem[i];
      if (item === 0 || UPGRADES[item - 1].effect !== effect) continue;
      if (canBuy(s, 0, i)) return i;
    }
  }
  return -1;
}

/**
 * Лавка и Дар: бот обязан пройти их по той же причине, что и дверь.
 *
 * Экран ждёт игрока (ECONOMY §5: покупка конкурирует с долей заведения, а
 * такое решение не принимают по таймеру), и прогон, которому некому нажать
 * кнопку, встаёт на нём навсегда — молча и до конца отведённых тиков.
 *
 * Дар проходится тем же кодом: ценник у него нулевой, `canBuy` пропускает
 * первое же предложение, а взятый апгрейд закрывает экран сам.
 *
 * Выбор товара — предмет СТРАТЕГИИ (задача 2.5): бот без профиля идёт слева
 * направо и берёт первое доступное, как и раньше — это ботов, не изображающих
 * игрока, не касается ни один ограничитель ECONOMY §13. Профильный бот сперва
 * ищет слот с товаром по вершине своего приоритета (`pickShopSlot`); нет
 * такого — падает на то же поведение слева направо, потому что НЕ купить
 * нельзя: ограничители G2 и G3 считают купленное за забег, и бот, уходящий с
 * полным кошельком, обнулял бы оба.
 *
 * Кнопка отпускается через тик, и это не стиль, а условие работоспособности:
 * экран читает нажатия по фронту, а удержанная кнопка срабатывает ровно
 * однажды. Двум подряд «вправо» нужен зазор, иначе фокус встаёт на первом
 * товаре навсегда — и прогон вместе с ним. `canBuy` при этом спрашивается тот
 * же самый, что и в покупке: разъедься они, бот жал бы «купить» вечно.
 */
export function passReward(
  s: SimState,
  frames: readonly InputFrame[],
  strategyName?: StrategyName,
): readonly InputFrame[] {
  if (s.meta[Meta.Phase] !== RunPhase.Reward) return frames;

  const focus = s.meta[Meta.DoorPick];
  const target = strategyName ? pickShopSlot(s, strategyName) : -1;

  let button: number;
  if (focus < 0) button = Btn.NavLeft;
  else if (target >= 0 && focus !== target) button = focus < target ? Btn.NavRight : Btn.NavLeft;
  else if (canBuy(s, 0, focus)) button = Btn.Confirm;
  else if (focus < SHOP_SLOTS - 1) button = Btn.NavRight;
  else button = Btn.Cancel;

  // Кадр собирается с нуля, а не поверх боевого: зажатый огонь и биты аппетита
  // на экране лавки не значат ничего, а вот `Confirm` от Ставки Крупье значил бы
  // покупку, которой бот не решал.
  const out = frames.map((f) => ({ ...f, buttons: 0 }));
  if (s.tick % 2 === 0) out[0].buttons = button;
  return out;
}
