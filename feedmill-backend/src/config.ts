import fs from 'fs';
import path from 'path';
import type {
  EquipmentRuntime, FlowConnection, Bin, Recipe, Ingredient,
  ScaleConfig, OmronConfig,
} from './types.js';

export interface MillConfig {
  equipment: EquipmentRuntime[];
  connections: FlowConnection[];
  bins: Bin[];
  ingredients: Ingredient[];
  recipes: Recipe[];
  scaleConfigs: ScaleConfig[];
  omronConfig: OmronConfig;
  globalConfig: Record<string, string | number>;
}

const CONFIG_DIR = process.env.MILL_DATA_DIR ?? path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(): MillConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as MillConfig;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: MillConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}
