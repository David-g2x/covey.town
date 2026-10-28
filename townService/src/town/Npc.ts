import {
  NpcActivityState,
  NpcAppearanceID,
  NpcModel,
  PlayerLocation,
} from '../types/CoveyTownSocket';

/** Stores and manages one NPC's server-side data. */
export default class Npc {
  private _model: NpcModel;

  constructor(model: NpcModel) {
    this._model = {
      id: model.id,
      name: model.name,
      appearance: model.appearance,
      personality: model.personality,
      location: { ...model.location },
      state: model.state,
    };
  }

  /** Updates the NPC's location and behavior using server-calculated data. */
  public updateMovement(location: PlayerLocation, state: NpcActivityState): void {
    this._model.location = { ...location };
    this._model.state = state;
  }

  /** Updates which character appearance the NPC uses. */
  public updateAppearance(appearance: NpcAppearanceID): void {
    this._model.appearance = appearance;
  }

  /** Returns a copy so callers cannot modify the stored data directly. */
  public toModel(): NpcModel {
    return {
      ...this._model,
      location: { ...this._model.location },
    };
  }
}
