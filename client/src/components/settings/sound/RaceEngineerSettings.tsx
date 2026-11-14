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
  setEngineerVoiceUri,
  setEngineerVolume,
  setListenHere,
  speakRaceEngineer,
} from "@/lib/race-engineer-voice";
import { m } from "@/paraglide/messages";

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
        </div>
        <div>
          <Label htmlFor="race-engineer-volume" className="text-app-text-secondary mb-2 block">
            {m.label_volume()} — {Math.round(volume * 100)}%
          </Label>
          <input
            id="race-engineer-volume"
            type="range"
            min="0"
            max="100"
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
    </section>
  );
}
