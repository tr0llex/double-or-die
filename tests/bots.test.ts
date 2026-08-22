/**
 * Боты: профили «навык × стратегия» и смесь.
 *
 * Проверяется не «бот играет хорошо» — такого требования нет, — а три вещи,
 * без которых прогоны балансировщика ничего не стоят. Профиль обязан быть
 * воспроизводим от сида, иначе ни один ограничитель не сравнить между
 * правками. Навык обязан быть РАЗЛИЧИМ измеримо, иначе четыре строки таблицы
 * SIMULATION §3 — это украшение, а все прогоны меряют одного и того же
 * игрока. И смесь обязана давать заявленные доли, иначе `--bot mixed`
 * называет аудиторией то, чего не считал.
 */

import { describe, expect, it } from 'vitest';
import {
  BetState,
  Btn,
  EntityFlag,
  MAX_ACTIVE_BETS,
  Meta,
  PLAYER,
  RunPhase,
  createState,
  hashState,
  spawnPlayers,
  step,
  type InputFrame,
} from '@dod/sim';
import {
  BOT_NAMES,
  PROFILE_NAMES,
  SKILL_NAMES,
  STRATEGY_NAMES,
  isBotName,
  makeBot,
  mixedProfile,
  type BotName,
} from '@dod/tools/bots';
import { Observer } from '@dod/tools/observe';

/** Прогон до смерти, конца забега или потолка тиков. Отдаёт прожитые тики. */
function survive(bot: BotName, seed: number, ticks: number): number {
  const s = createState(seed, 1);
  spawnPlayers(s);
  const b = makeBot(bot, seed, 1);
  for (let t = 0; t < ticks; t++) {
    step(s, b.inputs(s));
    if (s.meta[Meta.Phase] === RunPhase.Summary) return s.tick;
    if ((s.pFlags[0] & EntityFlag.Alive) === 0) return s.tick;
  }
  return ticks;
}

/** Лог ввода забега: копии кадров, а не ссылки на переиспользуемые буферы. */
function inputLog(bot: BotName, seed: number, ticks: number): InputFrame[] {
  const s = createState(seed, 1);
  spawnPlayers(s);
  const b = makeBot(bot, seed, 1);
  const log: InputFrame[] = [];
  for (let t = 0; t < ticks; t++) {
    const frames = b.inputs(s);
    log.push({ ...frames[0] });
    step(s, frames);
  }
  return log;
}

describe('список профилей', () => {
  it('содержит все пары «навык:стратегия» и прежние имена', () => {
    expect(PROFILE_NAMES).toHaveLength(SKILL_NAMES.length * STRATEGY_NAMES.length);
    for (const name of BOT_NAMES) expect(isBotName(name)).toBe(true);
    // Прежние имена не исчезают: на них записан корпус golden-эталонов и
    // ссылается DEVLOOP §3.
    for (const name of ['idle', 'random', 'greedy', 'cautious', 'mixed']) {
      expect(isBotName(name)).toBe(true);
    }
    expect(isBotName('master:kelly')).toBe(false);
    expect(isBotName('мастер:stack')).toBe(false);
  });

  it('каждый профиль называет себя тем, чем его просили', () => {
    for (const name of PROFILE_NAMES) expect(makeBot(name, 1, 1).profile).toBe(name);
  });
});

describe('воспроизводимость от сида', () => {
  it('один профиль и один сид дают тот же ввод и тот же хеш', () => {
    for (const name of ['median:single', 'master:stack', 'novice:chips'] as const) {
      const a = inputLog(name, 7, 400);
      const b = inputLog(name, 7, 400);
      expect(b).toEqual(a);
    }
  });

  it('разные профили на одном сиде расходятся', () => {
    const a = inputLog('novice:stack', 7, 400);
    const b = inputLog('master:stack', 7, 400);
    expect(b).not.toEqual(a);

    const s1 = createState(7, 1);
    spawnPlayers(s1);
    const s2 = createState(7, 1);
    spawnPlayers(s2);
    const b1 = makeBot('median:none', 7, 1);
    const b2 = makeBot('median:stack', 7, 1);
    for (let t = 0; t < 600; t++) {
      step(s1, b1.inputs(s1));
      step(s2, b2.inputs(s2));
    }
    // Стратегия — это тоже поведение: не берущий карт и стакающий не могут
    // сойтись в одном состоянии.
    expect(hashState(s2)).not.toBe(hashState(s1));
  });
});

describe('ось навыка различима измеримо', () => {
  /**
   * Мастер живёт дольше новичка на ОДНИХ И ТЕХ ЖЕ сидах. Сравнивается сумма
   * по забегам, а не один забег: разброс исходов — свойство игры про азарт,
   * и один забег ничего не доказывает ни в какую сторону.
   *
   * ПОТОЛОК ТИКОВ ОБРЕЗАЕТ ИМЕННО ТО, ЧТО ТЕСТ МЕРЯЕТ. Прежние 6000 тиков —
   * это сто секунд, то есть примерно три комнаты: мастер упирался в потолок
   * там, где его преимущество только начиналось, и разница схлопывалась к
   * единице искусственно. Потолок поднят до забега целиком, а число сидов
   * втрое — порог в +25% должен ловить исчезновение разницы, а не разброс
   * десяти бросков.
   *
   * Стратегия `none`, а не `stack`: `stack` держит до четырёх пари и играет
   * под них (не жмёт рывок с «Без рывка», лезет за фишками с «Собери все
   * фишки»), то есть меняет живучесть по СТРАТЕГИЧЕСКОЙ причине. Ось навыка
   * меряется там, где стратегия не вмешивается.
   */
  it('мастер выживает дольше новичка', () => {
    let novice = 0;
    let master = 0;
    for (let seed = 1; seed <= 30; seed++) {
      novice += survive('novice:none', seed, 60_000);
      master += survive('master:none', seed, 60_000);
    }
    expect(master).toBeGreaterThan(novice * 1.25);
  }, 120_000);

  it('стрельба и уклонение отличаются по профилям, а не только в таблице', () => {
    const fireShare = (name: BotName): number => {
      const log = inputLog(name, 3, 1200);
      // Бит огня, а не выстрелы: доля времени с зажатым курком — это то, что
      // задано профилем (DIFFICULTY §1), а сколько из этого превратилось в
      // попадания, решает уже игра.
      return log.filter((f) => (f.buttons & Btn.Fire) !== 0).length / log.length;
    };
    const novice = fireShare('novice:stack');
    const master = fireShare('master:stack');
    // Заявлено 0.35 против 0.70. Допуск ±0.12: окно решения — 10 тиков, и на
    // тысяче двухстах тиках это сто двадцать бросков, а не бесконечность.
    expect(novice).toBeGreaterThan(0.23);
    expect(novice).toBeLessThan(0.47);
    expect(master).toBeGreaterThan(0.58);
    expect(master).toBeLessThan(0.82);
  });
});

describe('смесь профилей', () => {
  it('детерминирована от сида', () => {
    for (const seed of [1, 42, 1234, 999_983]) {
      expect(mixedProfile(seed)).toBe(mixedProfile(seed));
      expect(makeBot('mixed', seed, 1).profile).toBe(mixedProfile(seed));
    }
  });

  it('даёт заявленные доли', () => {
    const skills = new Map<string, number>();
    const strategies = new Map<string, number>();
    const runs = 2000;
    for (let seed = 1; seed <= runs; seed++) {
      const [skill, strategy] = mixedProfile(seed).split(':');
      skills.set(skill, (skills.get(skill) ?? 0) + 1);
      strategies.set(strategy, (strategies.get(strategy) ?? 0) + 1);
    }
    const share = (m: Map<string, number>, k: string): number => ((m.get(k) ?? 0) / runs) * 100;

    // Доли из SIMULATION §3. Допуск ±4 процентных пункта: две тысячи
    // розыгрышей дают стандартную ошибку около одного пункта, и допуск ловит
    // подменённую таблицу, не краснея от самой случайности.
    const near = (actual: number, target: number): void => {
      expect(actual).toBeGreaterThan(target - 4);
      expect(actual).toBeLessThan(target + 4);
    };
    near(share(skills, 'novice'), 25);
    near(share(skills, 'median'), 40);
    near(share(skills, 'veteran'), 25);
    near(share(skills, 'master'), 10);
    near(share(strategies, 'single'), 45);
    near(share(strategies, 'stack'), 35);
    near(share(strategies, 'chips'), 20);
  });

  /**
   * Трус в смесь не входит, и это не мелочь настройки. G6 требует, чтобы
   * забегов с нулём взятых пари было меньше 5%, а `none` не берёт их никогда:
   * заметная доля такого профиля валила бы ограничитель составом смеси, а не
   * балансом игры.
   */
  it('не содержит профиля, который не берёт пари', () => {
    for (let seed = 1; seed <= 500; seed++) {
      expect(mixedProfile(seed).endsWith(':none')).toBe(false);
    }
  });
});

describe('стратегии делают то, что обещают', () => {
  it('`none` не берёт ни одного пари, `stack` берёт', () => {
    const taken = (name: BotName): number => {
      const s = createState(11, 1);
      spawnPlayers(s);
      const b = makeBot(name, 11, 1);
      for (let t = 0; t < 3000; t++) step(s, b.inputs(s));
      return s.meta[Meta.BetsTaken];
    };
    expect(taken('median:none')).toBe(0);
    expect(taken('median:stack')).toBeGreaterThan(0);
  }, 20_000);

  it('`single` держит не больше одного пари разом', () => {
    const s = createState(5, 1);
    spawnPlayers(s);
    const b = makeBot('median:single', 5, 1);
    let peak = 0;
    for (let t = 0; t < 3000; t++) {
      step(s, b.inputs(s));
      let active = 0;
      for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
        if (s.aState[n] === BetState.Active) active++;
      }
      if (active > peak) peak = active;
    }
    expect(peak).toBeLessThanOrEqual(1);
  }, 20_000);

  it('`chips` подбирает больше фишек, чем тот же навык без погони за ними', () => {
    const earned = (name: BotName): number => {
      let total = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const s = createState(seed, 1);
        spawnPlayers(s);
        const b = makeBot(name, seed, 1);
        // Пари не берём в расчёт: кон списывается с кошелька, и сравнивать
        // надо подобранное, а не остаток. Поэтому обе стороны — стратегии с
        // одинаковым ставочным поведением, различающиеся только погоней.
        // Пауза между волнами и расчётом выросла (iter-3 §3.3 ТЗ-9/ТЗ-10):
        // 2400 тиков больше не хватает даже на одну комнату — окно вырезано
        // с запасом, чтобы обе стратегии реально столкнулись с фишками.
        for (let t = 0; t < 4800; t++) step(s, b.inputs(s));
        total += s.pChips[0];
      }
      return total;
    };
    expect(earned('median:chips')).toBeGreaterThan(earned('median:stack'));
  }, 30_000);
});

describe('наблюдение за забегом', () => {
  it('пари попадают в разбор по id, тиру и исходу', () => {
    const s = createState(4, 1);
    spawnPlayers(s);
    const b = makeBot('median:stack', 4, 1);
    const obs = new Observer(s);
    for (let t = 0; t < 4000; t++) {
      obs.before(s);
      step(s, b.inputs(s));
      obs.after(s);
    }
    const { bets, hits, rooms } = obs.report();

    // Взятых пари ровно столько, сколько насчитала сама симуляция: разбор
    // обязан сходиться со счётчиком, иначе G10 считается по разным числам.
    expect(bets).toHaveLength(s.meta[Meta.BetsTaken]);
    for (const bet of bets) {
      expect(bet.id).toMatch(/^[a-z0-9_]+$/);
      expect(['modest', 'normal', 'go_big']).toContain(bet.tier);
      expect(bet.floor).toBeGreaterThanOrEqual(1);
      expect(bet.room).toBeGreaterThanOrEqual(1);
    }
    // Тир Сборки решается один раз на весь забег (не на комнату — аппетит
    // выбирают за дверью), поэтому все пари одного прогона несут один и тот
    // же тир, каким бы он ни выпал на этом сиде.
    expect(new Set(bets.map((x) => x.tier)).size).toBe(1);

    // Комнаты считаются только завершённые: оборванная концом прогона — это
    // не быстрая комната, а отсутствие замера.
    for (const room of rooms) expect(room.ticks).toBeGreaterThan(0);

    // Сердца, отнятые за забег, сходятся с числом записанных попаданий.
    expect(hits.length).toBe(PLAYER.startHearts - s.pHearts[0]);
    for (const hit of hits) expect(['wedge', 'brick', 'fuse', 'unknown']).toContain(hit.by);
  }, 20_000);

  /**
   * Источник урона восстанавливается, а не назначается, поэтому у него есть
   * право не знать. Право это ограничено: D5 и D6 сравнивают ДОЛИ смертей по
   * врагам, и «неизвестный» в четверти случаев сдвинул бы обе. Замер на
   * момент написания — ноль неизвестных на десяти забегах.
   */
  it('источник урона опознаётся почти всегда', () => {
    let known = 0;
    let total = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = createState(seed, 1);
      spawnPlayers(s);
      const b = makeBot('median:stack', seed, 1);
      const obs = new Observer(s);
      for (let t = 0; t < 3000; t++) {
        obs.before(s);
        step(s, b.inputs(s));
        obs.after(s);
      }
      for (const hit of obs.report().hits) {
        total++;
        if (hit.by !== 'unknown') known++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(known / total).toBeGreaterThan(0.9);
  }, 40_000);
});
