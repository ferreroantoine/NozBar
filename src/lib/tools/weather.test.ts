import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({ native: { getLocation: vi.fn() } }));

import { native } from "../native";
import type { ToolContext } from "./types";
import { WEATHER_TOOL, wmoLabel } from "./weather";

const FORECAST = {
  current: { temperature_2m: 12.4, apparent_temperature: 10.9, weather_code: 3, wind_speed_10m: 14.2 },
  daily: {
    time: ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"],
    weather_code: [3, 61, 0, 0, 0, 0, 95],
    temperature_2m_max: [14, 11, 13, 13, 13, 13, 9],
    temperature_2m_min: [6, 7, 4, 4, 4, 4, 2],
    precipitation_probability_max: [10, 80, 0, 0, 0, 0, 90],
  },
};

const ctx = {
  ui: { status() {}, text() {}, sources() {}, confirm: async () => true },
  signal: new AbortController().signal,
  search: async () => ({ summary: "", sources: [] }),
} as unknown as ToolContext;

let fetchMock: ReturnType<typeof vi.fn>;

function respond(geocoding: unknown) {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.includes("geocoding-api") ? geocoding : FORECAST),
  }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("get_weather", () => {
  it("géocode la ville puis donne la prévision du jour demandé", async () => {
    respond({ results: [{ name: "Lyon", latitude: 45.75, longitude: 4.85 }] });
    const result = await WEATHER_TOOL.run({ city: "Lyon", days_ahead: 1 }, ctx);
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toContain("latitude=45.75");
    expect(result.data).toMatchObject({
      place: "Lyon",
      current: { temp: 12, label: "Couvert" },
      day: { date: "2026-11-01", min: 7, max: 11, rain: 80 },
    });
    expect((result.data?.day as { label: string }).label).toContain("Pluie");
  });

  it("ramène days_ahead entre 0 et 6", async () => {
    respond({ results: [{ name: "Lyon", latitude: 45.75, longitude: 4.85 }] });
    const far = await WEATHER_TOOL.run({ city: "Lyon", days_ahead: 10 }, ctx);
    expect((far.data?.day as { date: string }).date).toBe("2026-11-06");
    const past = await WEATHER_TOOL.run({ city: "Lyon", days_ahead: -1 }, ctx);
    expect((past.data?.day as { date: string }).date).toBe("2026-10-31");
  });

  it("signale une ville inconnue", async () => {
    respond({});
    const result = await WEATHER_TOOL.run({ city: "Zzyzx" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ville");
  });

  it("utilise la localisation Windows sans ville", async () => {
    vi.mocked(native.getLocation).mockResolvedValue({ lat: 48.85, lon: 2.35 });
    respond({});
    const result = await WEATHER_TOOL.run({}, ctx);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data?.place).toBe("votre position");
  });

  it("invite à demander la ville si la localisation est refusée", async () => {
    vi.mocked(native.getLocation).mockRejectedValue(new Error("Localisation Windows désactivée"));
    const result = await WEATHER_TOOL.run({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/demande.*ville/i);
  });
});

describe("wmoLabel", () => {
  it("traduit les codes météo", () => {
    expect(wmoLabel(0)).toBe("Ciel dégagé");
    expect(wmoLabel(61)).toContain("Pluie");
    expect(wmoLabel(999)).toBe("Conditions inconnues");
  });
});
