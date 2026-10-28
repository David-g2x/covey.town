import { NpcModel, PlayerLocation } from '../types/CoveyTownSocket';
import Npc from './Npc';

describe('Npc', () => {
  /** Starting data and NPC instance, recreated before each test. */
  let startingData: NpcModel;
  let npc: Npc;

  /** Creates a fresh NPC before every test so tests do not affect each other. */
  beforeEach(() => {
    startingData = {
      id: 'town-guide',
      name: 'Jane Doe',
      appearance: 'sky-explorer-female',
      personality: 'friendly-helper',
      location: {
        x: 100,
        y: 200,
        rotation: 'front',
        moving: false,
      },
      state: 'patrolling',
    };

    npc = new Npc(startingData);
  });

  /** Checks that the constructor stores the supplied starting values. */
  it('stores the starting NPC data', () => {
    expect(npc.toModel()).toEqual(startingData);
  });

  /** Changes the original input and checks that the stored NPC stays unchanged. */
  it('does not share its stored location with the starting data', () => {
    startingData.location.x = 999;
    startingData.name = 'NewName';

    expect(npc.toModel().location.x).toBe(100);
    expect(npc.toModel().name).toBe('Jane Doe');
  });

  /** Changes a returned copy and checks that the stored NPC stays unchanged. */
  it('returns a copy that cannot change the stored data', () => {
    const snapshot = npc.toModel();

    snapshot.location.x = 999;
    snapshot.appearance = 'cozy-guide-male';

    expect(npc.toModel().location.x).toBe(100);
    expect(npc.toModel().appearance).toBe('sky-explorer-female');
  });

  /** Checks movement updates preserve other fields and copy the supplied location. */
  it('updates movement and behavior without changing other NPC data', () => {
    const location: PlayerLocation = {
      x: 150,
      y: 200,
      rotation: 'right',
      moving: true,
    };

    npc.updateMovement(location, 'patrolling');

    expect(npc.toModel()).toEqual({
      ...startingData,
      location,
      state: 'patrolling',
    });

    location.x = 999;

    expect(npc.toModel().location.x).toBe(150);
  });

  /** Checks that a stopped location and facing-player state are stored together. */
  it('stores a stopped position when facing a player', () => {
    const location: PlayerLocation = {
      x: 150,
      y: 200,
      rotation: 'left',
      moving: false,
    };

    npc.updateMovement(location, 'facing-player');

    expect(npc.toModel().location).toEqual(location);
    expect(npc.toModel().state).toBe('facing-player');
  });

  /** Checks that changing appearance preserves the remaining NPC fields. */
  it('updates appearance without changing other NPC data', () => {
    npc.updateAppearance('cozy-guide-male');

    expect(npc.toModel()).toEqual({
      ...startingData,
      appearance: 'cozy-guide-male',
    });
  });
});