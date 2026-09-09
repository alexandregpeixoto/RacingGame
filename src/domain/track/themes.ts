import type { EnvironmentSettings, ThemeReference } from "./types";

export interface ThemePalette {
  id: string;
  name: string;
  terrain: string;
  road: string;
  roadEdge: string;
  centerline: string;
  kerbA: string;
  kerbB: string;
  runoff: Record<EnvironmentSettings["runoff"], string>;
  barrier: string;
  prop: string;
}

export const THEME_PACKS: ThemePalette[] = [
  {
    id: "base",
    name: "Base Motorsport",
    terrain: "#19342d",
    road: "#3d4148",
    roadEdge: "#b3bbc0",
    centerline: "#70d7ff",
    kerbA: "#f4f5ef",
    kerbB: "#e35f72",
    runoff: {
      grass: "#19342d",
      gravel: "#897f68",
      sand: "#c4a66a",
      asphalt: "#4f565c",
      concrete: "#89949a",
    },
    barrier: "#d8dee0",
    prop: "#77c58f",
  },
  {
    id: "realistic",
    name: "Realistic Motorsport",
    terrain: "#254b2d",
    road: "#383b40",
    roadEdge: "#d0d4d2",
    centerline: "#f1d16a",
    kerbA: "#f5f5f1",
    kerbB: "#df4757",
    runoff: {
      grass: "#254b2d",
      gravel: "#9d9276",
      sand: "#d7bc7b",
      asphalt: "#5a6063",
      concrete: "#adb4b3",
    },
    barrier: "#d6d9d7",
    prop: "#43875c",
  },
  {
    id: "cartoon",
    name: "Cartoon Kart",
    terrain: "#2c7a55",
    road: "#515675",
    roadEdge: "#ffe9a3",
    centerline: "#ff8ac2",
    kerbA: "#fff4bc",
    kerbB: "#ff75a8",
    runoff: {
      grass: "#2c7a55",
      gravel: "#c6a76d",
      sand: "#f2cb78",
      asphalt: "#686b95",
      concrete: "#b8c7e6",
    },
    barrier: "#f8d36c",
    prop: "#ffd166",
  },
];

export function getThemePalette(reference: ThemeReference): ThemePalette {
  return (
    THEME_PACKS.find((theme) => theme.id === reference.id) ?? THEME_PACKS[0]
  );
}
