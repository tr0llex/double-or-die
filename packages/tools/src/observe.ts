/**
 * Наблюдение за забегом: то, из чего считаются ограничители.
 *
 * Раннер и так отдаёт итоги забега (`packages/tools/src/cli.ts`), но итог —
 * это сумма, а ограничители ECONOMY §13 и DIFFICULTY §10 считаются по
 * событиям: G10 хочет знать, КАКОЕ пари взяли, G4 — каким тиром, G14 — чем
 * оно кончилось, D1 — сколько длилась каждая комната, D5 и D6 — кто именно
 * убил. Суммарные счётчики на эти вопросы не отвечают, и досчитать их потом
 * нельзя: забег уже кончился.
 *
 * Наблюдатель живёт СНАРУЖИ симуляции и ничего в ней не трогает. Ядру
 * запрещено аллоцировать в горячем пути, поэтому лога событий оно не ведёт
 * (шапка `packages/shared/src/events.ts`) — всё, что известно о забеге, живёт
 * в `Meta` и в буферах состояния, и наблюдать за ними можно только так: снимок
 * до тика, сравнение после.
 */

import {
  BetState,
  BETS,
  FX_ONE,
  cashOutValue,
  ENEMIES,
  ENEMY_BULLET,
  ENEMY_OWNER,
  EnemyPhase,
  EnemyType,
  FUSE,
  MAX_ACTIVE_BETS,
  MAX_BULLETS,
  MAX_ENEMIES,
  MAX_PLAYERS,
  Meta,
  PLAYER,
  WEDGE,
  type SimState,
  toFloat,
} from '@dod/sim';

/** Имена тиров аппетита из GLOSSARY §4. В отчёте — словом, а не индексом. */
const TIER_NAMES = ['modest', 'normal', 'go_big'] as const;

/**
 * Кто нанёс урон. Три источника — ровно те три, что существуют в 0.4.0:
 * таран Клина, ударная волна Фитиля и снаряд Кирпича (`combat.ts`).
 * `unknown` оставлен честно: лучше признанный пробел, чем приписанная вина.
 */
export type Killer = 'wedge' | 'brick' | 'fuse' | 'unknown';

export interface BetRecord {
  player: number;
  /** Строковый id из каталога: `no_damage`, `under_45s`, … Знаменатель G10. */
  id: string;
  /**
   * Кон в фишках — уже с поправкой «не больше кошелька». Всегда неотрицателен:
   * у Ставки Крупье ядро хранит его со знаком минус (это его метка), а
   * наблюдателю метка не нужна — у него для этого есть `ace`.
   */
  stake: number;
  /**
   * Ставка Крупье: ставит он, из своего кармана, выплата один к одному
   * (ECONOMY §10А). Пишется полем, а не выводится из знака кона: G12 отличал
   * её по `stake < 0`, то есть по внутренней метке ядра, которую ядро вправе
   * поменять, не сказав никому.
   */
  ace: boolean;
  /**
   * Сколько фишек пари принесло игроку на расчёте, ровно по правилам ядра:
   * выигрыш — `кон × множитель` (а у Ставки Крупье — её кон один к одному),
   * обналичивание — `кон × (1 + q(M−1)/2)`, провал — ноль.
   *
   * Считается тем же кодом, что платит (`cashOutValue`), и снимается ДО тика
   * разрешения: после него прогресс `q` уже стёрт, и восстановить выплату
   * нечем. Это единственный способ считать доход пари точно — G5 до этого
   * брал НОМИНАЛЬНЫЙ множитель каталога и огрублял обналиченное до `q≈1`,
   * то есть считал не то, что игрок получил, а то, что он получил бы в
   * среднем по своим же предположениям.
   */
  payout: number;
  /** Тир аппетита в момент взятия: `modest` / `normal` / `go_big` (G4). */
  tier: string;
  floor: number;
  room: number;
  takenAt: number;
  /** `won` / `lost` / `cashed`; `active` — забег кончился раньше расчёта. */
  outcome: 'won' | 'lost' | 'cashed' | 'active';
  resolvedAt: number;
}

export interface RoomRecord {
  floor: number;
  room: number;
  ticks: number;
}

export interface HitRecord {
  player: number;
  tick: number;
  floor: number;
  room: number;
  by: Killer;
  /** Это попадание отняло последнее сердце. Из таких считаются D5 и D6. */
  fatal: boolean;
}

export interface Observation {
  bets: BetRecord[];
  rooms: RoomRecord[];
  hits: HitRecord[];
}

const outcomeOf = (state: number): BetRecord['outcome'] => {
  switch (state) {
    case BetState.Won:
      return 'won';
    case BetState.Cashed:
      return 'cashed';
    case BetState.Lost:
      return 'lost';
    default:
      return 'active';
  }
};

/**
 * Наблюдатель одного забега.
 *
 * Снимок берётся ДО тика, разбор — после. Иначе источник урона не
 * восстановить: Клин, доставший игрока тараном, в том же тике уходит в откат,
 * снаряд Кирпича гасится о попадание, а взорвавшийся Фитиль снимается с арены
 * до самого взрыва (`chainDetonate`), — то есть после тика на арене не
 * остаётся ни одной из трёх улик.
 */
export class Observer {
  private readonly bets: BetRecord[] = [];
  private readonly rooms: RoomRecord[] = [];
  private readonly hits: HitRecord[] = [];

  /** Пари в работе: индекс слота → запись, которую ещё предстоит закрыть. */
  private readonly open = new Map<number, BetRecord>();
  private readonly betState = new Int32Array(MAX_PLAYERS * MAX_ACTIVE_BETS);
  /**
   * Что стоило бы каждое активное пари, обналичь его игрок ПРЯМО СЕЙЧАС.
   *
   * Снимается перед тиком вместе с остальными уликами и по той же причине:
   * прогресс `q` живёт только пока пари активно, а к разбору после тика от
   * него не остаётся ничего.
   */
  private readonly cashValue = new Int32Array(MAX_PLAYERS * MAX_ACTIVE_BETS);

  private readonly hearts = new Int32Array(MAX_PLAYERS);
  private readonly px = new Int32Array(MAX_PLAYERS);
  private readonly py = new Int32Array(MAX_PLAYERS);

  private readonly eActive = new Uint8Array(MAX_ENEMIES);
  private readonly eType = new Int32Array(MAX_ENEMIES);
  private readonly ePhase = new Int32Array(MAX_ENEMIES);
  private readonly eX = new Int32Array(MAX_ENEMIES);
  private readonly eY = new Int32Array(MAX_ENEMIES);

  private readonly bActive = new Uint8Array(MAX_BULLETS);
  private readonly bOwner = new Int32Array(MAX_BULLETS);
  private readonly bX = new Int32Array(MAX_BULLETS);
  private readonly bY = new Int32Array(MAX_BULLETS);

  private roomStart: number;
  private roomNo: number;
  private floorNo: number;

  constructor(s: SimState) {
    this.roomStart = s.meta[Meta.RoomStartTick];
    this.roomNo = s.meta[Meta.Room];
    this.floorNo = s.meta[Meta.Floor];
    this.hearts.set(s.pHearts);
    this.betState.set(s.aState);
  }

  /** Снять улики перед тиком. Копирование буферов — один `set` на буфер. */
  before(s: SimState): void {
    this.hearts.set(s.pHearts);
    this.px.set(s.pX);
    this.py.set(s.pY);
    this.eActive.set(s.eActive);
    this.eType.set(s.eType);
    this.ePhase.set(s.ePhase);
    this.eX.set(s.eX);
    this.eY.set(s.eY);
    this.bActive.set(s.bActive);
    this.bOwner.set(s.bOwner);
    this.bX.set(s.bX);
    this.bY.set(s.bY);
    for (let p = 0; p < s.playerCount; p++) {
      for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
        const k = p * MAX_ACTIVE_BETS + n;
        this.cashValue[k] = s.aState[k] === BetState.Active ? cashOutValue(s, p, n) : 0;
      }
    }
  }

  /** Разобрать, что тик изменил. */
  after(s: SimState): void {
    this.trackRoom(s);
    this.trackBets(s);
    this.trackHits(s);
  }

  /**
   * Комнаты считаются по `RoomStartTick`, а не по номеру: перезапуск и переход
   * на новый этаж возвращают нумерацию к единице, и по номеру такая комната
   * потерялась бы вместе со своей длительностью — а это как раз самые
   * интересные комнаты. Номер этажа и комнаты пишется тот, с которым она
   * НАЧАЛАСЬ: D1 сравнивает длительности одной и той же комнаты между
   * составами, и подпись от конца сдвинула бы всю таблицу на единицу.
   */
  private trackRoom(s: SimState): void {
    const start = s.meta[Meta.RoomStartTick];
    if (start === this.roomStart) return;
    this.rooms.push({ floor: this.floorNo, room: this.roomNo, ticks: start - this.roomStart });
    this.roomStart = start;
    this.roomNo = s.meta[Meta.Room];
    this.floorNo = s.meta[Meta.Floor];
  }

  private trackBets(s: SimState): void {
    for (let p = 0; p < s.playerCount; p++) {
      for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
        const k = p * MAX_ACTIVE_BETS + n;
        const now = s.aState[k];
        const was = this.betState[k];
        this.betState[k] = now;
        if (now === was) continue;

        if (now === BetState.Active) {
          const tier = Math.min(TIER_NAMES.length - 1, Math.max(0, s.pAppetite[p]));
          const rec: BetRecord = {
            player: p,
            id: BETS[s.aBet[k]].id,
            stake: Math.abs(s.aStake[k]),
            ace: s.aStake[k] < 0,
            payout: 0,
            tier: TIER_NAMES[tier],
            floor: s.meta[Meta.Floor],
            room: s.meta[Meta.Room],
            takenAt: s.tick,
            outcome: 'active',
            resolvedAt: 0,
          };
          this.bets.push(rec);
          this.open.set(k, rec);
          continue;
        }

        // Слот освобождается началом следующего боя, а не расчётом: между
        // разрешением и обнулением проходит целый экран, и `None` в конце —
        // это уборка, а не второй исход.
        const rec = this.open.get(k);
        if (rec === undefined) continue;
        if (now === BetState.None) {
          this.open.delete(k);
          continue;
        }
        rec.outcome = outcomeOf(now);
        rec.resolvedAt = s.tick;
        rec.payout = this.payoutOf(rec, now, k, s.aBet[k]);
        this.open.delete(k);
      }
    }
  }

  /**
   * Сколько фишек принесло разрешившееся пари — теми же правилами, что платит
   * ядро (`settleBets`, `cashOut` в `bets.ts`).
   *
   * Копия формулы, а не вызов: платит ядро внутри тика, а наблюдатель разбирает
   * его последствия снаружи — к моменту разбора и состояние пари, и прогресс
   * уже другие. Поэтому обналиченное берётся из снимка ДО тика (`cashValue`),
   * а выигрыш пересчитывается по кону и множителю, которые не меняются.
   */
  private payoutOf(rec: BetRecord, state: number, k: number, bet: number): number {
    if (state === BetState.Cashed) return this.cashValue[k];
    if (state !== BetState.Won) return 0;
    // Ставка Крупье платит один к одному и из его кармана: кон игрока в ней
    // не участвует вовсе (ECONOMY §10А).
    if (rec.ace) return rec.stake;
    return Math.trunc((rec.stake * BETS[bet].multiplier) / FX_ONE);
  }

  /**
   * Кто отнял сердце.
   *
   * Ядро источника урона не запоминает и запоминать не должно: это поле в
   * состоянии, в снимке и в хеше ради одной проверки в CI. Поэтому источник
   * ВОССТАНАВЛИВАЕТСЯ по уликам предыдущего тика, и порядок проверок — от
   * однозначного к вероятному: волна Фитиля бьёт по площади и опознаётся по
   * исчезнувшему поджёгшему фитиль Фитилю, таран — по Клину в фазе атаки
   * вплотную, снаряд — по погасшей вражеской пуле рядом.
   *
   * Оценка честная, а не точная, и `unknown` в отчёте — это признание, а не
   * округление: D5 и D6 сравнивают ДОЛИ смертей по врагам, и приписанная
   * вина сдвинула бы обе.
   */
  private trackHits(s: SimState): void {
    for (let p = 0; p < s.playerCount; p++) {
      const lost = this.hearts[p] - s.pHearts[p];
      if (lost <= 0) continue;
      this.hits.push({
        player: p,
        tick: s.tick,
        floor: s.meta[Meta.Floor],
        room: s.meta[Meta.Room],
        by: this.blame(s, p),
        fatal: s.pHearts[p] <= 0,
      });
    }
  }

  private blame(s: SimState, p: number): Killer {
    const px = toFloat(this.px[p]);
    const py = toFloat(this.py[p]);
    const playerR = toFloat(PLAYER.radius);

    // Фитиль: взорвался и снялся с арены в этом тике.
    const blast = toFloat(FUSE.blastRadius) + playerR;
    for (let e = 0; e < MAX_ENEMIES; e++) {
      if (!this.eActive[e] || s.eActive[e]) continue;
      if (this.eType[e] !== EnemyType.Fuse || this.ePhase[e] !== EnemyPhase.Telegraph) continue;
      if (Math.hypot(toFloat(this.eX[e]) - px, toFloat(this.eY[e]) - py) <= blast) return 'fuse';
    }

    // Снаряд Кирпича: погас в этом тике рядом с игроком. Стреляет в 0.4.0
    // только он, поэтому владельца различать не нужно — достаточно того, что
    // пуля вражеская. Улика точная, поэтому проверяется раньше тарана, у
    // которого допуск самый широкий.
    const bulletReach = toFloat(ENEMY_BULLET.radius) + playerR + toFloat(ENEMY_BULLET.speed);
    for (let b = 0; b < MAX_BULLETS; b++) {
      if (!this.bActive[b] || s.bActive[b]) continue;
      if (this.bOwner[b] !== ENEMY_OWNER) continue;
      if (Math.hypot(toFloat(this.bX[b]) - px, toFloat(this.bY[b]) - py) <= bulletReach) {
        return 'brick';
      }
    }

    // Клин: летел тараном и был вплотную. Расстояние меряется ДО тика, а
    // касание случилось внутри него, поэтому к сумме радиусов прибавляется
    // то, что за тик успевают закрыть оба: рывок Клина и шаг игрока. Без этой
    // поправки половина таранов оставалась «неизвестным источником» — замер
    // давал 39–54 единицы там, где сумма радиусов даёт 38.
    const wedgeReach =
      toFloat(ENEMIES[EnemyType.Wedge].radius) +
      playerR +
      toFloat(WEDGE.dashSpeed) +
      toFloat(PLAYER.speed);
    for (let e = 0; e < MAX_ENEMIES; e++) {
      if (!this.eActive[e]) continue;
      if (this.eType[e] !== EnemyType.Wedge) continue;
      if (this.ePhase[e] !== EnemyPhase.Attack && this.ePhase[e] !== EnemyPhase.Telegraph) continue;
      if (Math.hypot(toFloat(this.eX[e]) - px, toFloat(this.eY[e]) - py) <= wedgeReach) {
        return 'wedge';
      }
    }

    return 'unknown';
  }

  /**
   * Отчёт. Незакрытые пари остаются с исходом `active` — забег кончился
   * раньше, чем их разрешили, и объявлять их проигранными наблюдатель права
   * не имеет: это делает симуляция (`endRun`), а не тот, кто смотрит.
   */
  report(): Observation {
    return { bets: this.bets, rooms: this.rooms, hits: this.hits };
  }
}
