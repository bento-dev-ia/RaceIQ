import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import {
  getEngineerVoiceUri,
  getEngineerVolume,
  getListenHere,
  listPortugueseVoices,
  MAX_ENGINEER_VOLUME,
  refreshEngineerVoice,
  setEngineerVoiceUri,
  setEngineerVolume,
  setListenHere,
  speakRaceEngineer,
} from "@/lib/race-engineer-voice";
import { m } from "@/paraglide/messages";
import { authenticatedFetch } from "@/lib/rpc";
import { RaceEngineerOverlayButton } from "@/components/RaceEngineerOverlayButton";
import { RaceEngineerSectorHistory } from "./RaceEngineerSectorHistory";

const SAMPLE_CALLOUT = "La Source, segunda, freia nos 100 metros. Solta o freio devagar até o ápice.";

function usePortugueseVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listPortugueseVoices());
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const update = () => setVoices(listPortugueseVoices());
    window.speechSynthesis.addEventListener("voiceschanged", update);
    update();
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}

/** ElevenLabs key + voice: natural engineer voice, louder than browser speech can be. */
function PremiumVoiceSettings({ voiceId, onVoiceId }: { voiceId: string; onVoiceId: (id: string) => void }) {
  const [status, setStatus] = useState<{ premium: boolean; voiceId: string; error: string | null } | null>(null);
  const [key, setKey] = useState("");
  const [voice, setVoice] = useState(voiceId);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    try {
      const res = await authenticatedFetch("/api/race-engineer/voice");
      if (res.ok) setStatus((await res.json()) as typeof status);
    } catch {
      /* offline */
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => setVoice(voiceId), [voiceId]);
  const saveKey = async () => {
    setSaving(true);
    try {
      await authenticatedFetch("/api/race-engineer/voice-key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
      setKey("");
      refreshEngineerVoice();
      await load();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-app-border p-3">
      <p className="text-sm font-medium text-app-text">{m.race_engineer_premium_voice()}</p>
      <p className="text-xs text-app-text-muted">{m.race_engineer_premium_voice_desc()}</p>
      <p className="text-xs" aria-live="polite">
        {status?.premium
          ? <span className="text-status-success">{m.race_engineer_premium_on()}</span>
          : <span className="text-app-text-muted">{m.race_engineer_premium_off()}</span>}
        {status?.error ? <span className="ml-2 text-status-danger">{status.error}</span> : null}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="race-engineer-elevenlabs-key" className="text-app-text-secondary mb-1 block text-xs">{m.race_engineer_elevenlabs_key()}</Label>
          <input
            id="race-engineer-elevenlabs-key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={status?.premium ? "••••••••" : "sk_…"}
            className="h-9 w-64 rounded-md border border-app-border bg-app-surface px-2 text-sm text-app-text"
          />
        </div>
        <Button size="sm" variant="outline" disabled={saving || key.trim().length === 0} onClick={() => void saveKey()}>{m.race_engineer_save_key()}</Button>
        <div>
          <Label htmlFor="race-engineer-voice-id" className="text-app-text-secondary mb-1 block text-xs">{m.race_engineer_voice_id()}</Label>
          <input
            id="race-engineer-voice-id"
            value={voice}
            onChange={(e) => setVoice(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
            onBlur={() => {
              if (voice !== voiceId) {
                onVoiceId(voice);
                refreshEngineerVoice();
              }
            }}
            placeholder={status?.voiceId ?? ""}
            className="h-9 w-56 rounded-md border border-app-border bg-app-surface px-2 text-sm text-app-text"
          />
        </div>
      </div>
    </div>
  );
}

export function RaceEngineerSettings() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const voices = usePortugueseVoices();
  const [listenHere, setListenHereState] = useState(() => getListenHere());
  const [voiceUri, setVoiceUriState] = useState(() => getEngineerVoiceUri() ?? "");
  const [volume, setVolumeState] = useState(() => getEngineerVolume());

  return (
    <section className="mt-8 flex flex-col gap-4" aria-labelledby="race-engineer-title">
      <div>
        <h2 id="race-engineer-title" className="text-lg font-semibold text-app-text mb-1">{m.race_engineer_title()}</h2>
        <p className="text-sm text-app-text-muted">{m.race_engineer_desc()}</p>
      </div>
      <Field orientation="horizontal" className="items-start">
        <FieldContent>
          <FieldTitle>{m.race_engineer_enable()}</FieldTitle>
          <FieldDescription>{m.race_engineer_hotkey_hint()}</FieldDescription>
        </FieldContent>
        <Switch
          aria-label={m.race_engineer_enable()}
          checked={displaySettings.raceEngineerEnabled}
          disabled={saveSettings.isPending}
          onCheckedChange={(checked) => saveSettings.mutate({ raceEngineerEnabled: checked })}
        />
      </Field>
      <Field orientation="horizontal" className="items-start">
        <FieldContent>
          <FieldTitle>{m.race_engineer_bots()}</FieldTitle>
          <FieldDescription>{m.race_engineer_bots_desc()}</FieldDescription>
        </FieldContent>
        <Switch
          aria-label={m.race_engineer_bots()}
          checked={displaySettings.raceEngineerLearnFromBots}
          disabled={saveSettings.isPending}
          onCheckedChange={(checked) => saveSettings.mutate({ raceEngineerLearnFromBots: checked })}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <div>
          <p className="text-sm font-medium text-app-text">{m.race_engineer_overlay()}</p>
          <p className="text-sm text-app-text-muted">{m.race_engineer_overlay_desc()}</p>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="race-engineer-overlay-scale" className="text-app-text-secondary mb-2 block">{m.race_engineer_overlay_size()}</Label>
            <select
              id="race-engineer-overlay-scale"
              value={String(displaySettings.raceEngineerOverlayScale)}
              disabled={saveSettings.isPending}
              onChange={(e) => saveSettings.mutate({ raceEngineerOverlayScale: Number(e.target.value) })}
              className="h-9 rounded-md border border-app-border bg-app-surface px-2 text-sm text-app-text"
            >
              {[0.8, 1, 1.25, 1.5].map((s) => (
                <option key={s} value={String(s)}>{Math.round(s * 100)}%</option>
              ))}
            </select>
          </div>
          <RaceEngineerOverlayButton />
        </div>
      </div>
      <PremiumVoiceSettings voiceId={displaySettings.raceEngineerVoiceId} onVoiceId={(id) => saveSettings.mutate({ raceEngineerVoiceId: id })} />
      <Field orientation="horizontal" className="items-start">
        <FieldContent>
          <FieldTitle>{m.race_engineer_listen_here()}</FieldTitle>
        </FieldContent>
        <Switch
          aria-label={m.race_engineer_listen_here()}
          checked={listenHere}
          onCheckedChange={(checked) => {
            setListenHereState(checked);
            setListenHere(checked);
          }}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="race-engineer-voice" className="text-app-text-secondary mb-2 block">{m.race_engineer_voice()}</Label>
          <select
            id="race-engineer-voice"
            value={voiceUri}
            onChange={(e) => {
              setVoiceUriState(e.target.value);
              setEngineerVoiceUri(e.target.value || null);
            }}
            className="h-9 max-w-72 rounded-md border border-app-border bg-app-surface px-2 text-sm text-app-text"
          >
            <option value="">{m.race_engineer_voice_default()}</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>
            ))}
          </select>
          {!voices.some((v) => /natural|online|neural/i.test(v.name)) && (
            <p className="mt-2 max-w-72 text-xs text-app-text-muted">{m.race_engineer_voice_robotic_hint()}</p>
          )}
        </div>
        <div>
          <Label htmlFor="race-engineer-volume" className="text-app-text-secondary mb-2 block">
            {m.label_volume()} — {Math.round(volume * 100)}%
          </Label>
          <input
            id="race-engineer-volume"
            type="range"
            min="0"
            max={MAX_ENGINEER_VOLUME * 100}
            step="10"
            value={Math.round(volume * 100)}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10) / 100;
              setVolumeState(v);
              setEngineerVolume(v);
            }}
            className="w-48 accent-app-accent"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => speakRaceEngineer(SAMPLE_CALLOUT, true)}>
          {m.race_engineer_test()}
        </Button>
      </div>

      <RaceEngineerSectorHistory />
    </section>
  );
}
