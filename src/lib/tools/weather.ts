// Météo via Open-Meteo (gratuit, sans clé) : ville géocodée ou localisation Windows.

import { native } from "../native";
import { int, str, type Tool } from "./types";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS = 7;

/** Codes météo WMO utilisés par Open-Meteo. */
const WMO: Record<number, string> = {
  0: "Ciel dégagé", 1: "Plutôt dégagé", 2: "Partiellement nuageux", 3: "Couvert",
  45: "Brouillard", 48: "Brouillard givrant",
  51: "Bruine faible", 53: "Bruine", 55: "Bruine forte", 56: "Bruine verglaçante", 57: "Bruine verglaçante",
  61: "Pluie faible", 63: "Pluie", 65: "Pluie forte", 66: "Pluie verglaçante", 67: "Pluie verglaçante forte",
  71: "Neige faible", 73: "Neige", 75: "Neige forte", 77: "Grains de neige",
  80: "Averses faibles", 81: "Averses", 82: "Averses violentes", 85: "Averses de neige", 86: "Fortes averses de neige",
  95: "Orage", 96: "Orage avec grêle", 99: "Orage avec forte grêle",
};

export const wmoLabel = (code: number) => WMO[code] ?? "Conditions inconnues";

interface Forecast {
  current: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
  };
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Service météo indisponible (${res.status})`);
  return res.json() as Promise<T>;
}

function dayName(daysAhead: number, date: string): string {
  if (daysAhead === 0) return "aujourd'hui";
  if (daysAhead === 1) return "demain";
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

export const WEATHER_TOOL: Tool = {
  name: "get_weather",
  description:
    "Météo actuelle et prévision d'un jour (jusqu'à 6 jours à l'avance). Sans ville, utilise la position de l'ordinateur. " +
    "À utiliser pour toute question de météo plutôt que web_search.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "Ville, ex. « Lyon ». Omettre pour la position actuelle." },
      days_ahead: { type: "integer", description: "0 = aujourd'hui, 1 = demain… jusqu'à 6" },
    },
  },
  status: (a) => (str(a.city) ? `Météo à ${str(a.city)}…` : "Météo…"),
  async run(a, ctx) {
    const city = str(a.city);
    const daysAhead = Math.min(FORECAST_DAYS - 1, Math.max(0, int(a.days_ahead) ?? 0));

    let place: string;
    let lat: number;
    let lon: number;
    if (city) {
      const geo = await getJson<{ results?: { name: string; latitude: number; longitude: number }[] }>(
        `${GEOCODING_URL}?name=${encodeURIComponent(city)}&count=1&language=fr`,
        ctx.signal,
      );
      const hit = geo.results?.[0];
      if (!hit) return { ok: false, message: `Je ne trouve pas la ville « ${city} »` };
      ({ name: place, latitude: lat, longitude: lon } = hit);
    } else {
      try {
        ({ lat, lon } = await native.getLocation());
      } catch (e) {
        return {
          ok: false,
          message: `Position indisponible (${e instanceof Error ? e.message : String(e)}). Demande la ville à l'utilisateur.`,
        };
      }
      place = "votre position";
    }

    const f = await getJson<Forecast>(
      `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        `&timezone=auto&forecast_days=${FORECAST_DAYS}`,
      ctx.signal,
    );
    const current = {
      temp: Math.round(f.current.temperature_2m),
      feels: Math.round(f.current.apparent_temperature),
      label: wmoLabel(f.current.weather_code),
      wind: Math.round(f.current.wind_speed_10m),
    };
    const i = daysAhead;
    const day = {
      date: f.daily.time[i],
      label: wmoLabel(f.daily.weather_code[i]),
      min: Math.round(f.daily.temperature_2m_min[i]),
      max: Math.round(f.daily.temperature_2m_max[i]),
      rain: f.daily.precipitation_probability_max[i] ?? 0,
    };
    const when = dayName(daysAhead, day.date);
    return {
      ok: true,
      message:
        `${place}, ${when} : ${day.label}, ${day.min} à ${day.max} °C, risque de pluie ${day.rain} %. ` +
        `Actuellement ${current.temp} °C (ressenti ${current.feels} °C), ${current.label.toLowerCase()}, vent ${current.wind} km/h.`,
      data: { place, current, day },
    };
  },
};
