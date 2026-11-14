; installer/raceiq.iss
; Compile with: iscc /DMyAppVersion=1.0.0 installer\raceiq.iss
;
; Fork hardening (bento-dev-ia/RaceIQ): no hidden PowerShell, no forced
; start-with-Windows, no VBS launcher, no killing of unrelated processes.
; These upstream behaviours are legitimate but match trojan heuristics.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "RaceIQ"
#define MyAppPublisher "SpeedHQ (fork: bento-dev-ia)"
#define MyAppURL "https://github.com/bento-dev-ia/RaceIQ"
#define MyAppExeName "raceiq.exe"

[Setup]
AppId={{d023ef37-98d7-40de-94b3-58cea61b4d95}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..
OutputBaseFilename=RaceIQ-Setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
SetupIconFile=..\assets\raceiq.ico
UninstallFilesDir={app}\uninstall
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[CustomMessages]
english.StartWithWindows=Start RaceIQ when Windows starts
brazilianportuguese.StartWithWindows=Iniciar o RaceIQ com o Windows
english.StopRaceIQ=Stop RaceIQ
brazilianportuguese.StopRaceIQ=Encerrar RaceIQ

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "{cm:StartWithWindows}"; Flags: unchecked

[Code]
const
  OldAppId = '{d023ef37-98d7-40de-94b3-58cea61b4d95}_is1';

function GetOldUninstallString(): String;
var
  UninstallKey: String;
begin
  Result := '';
  // Check both 64-bit and 32-bit registry for the old admin install
  UninstallKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + OldAppId;
  if not RegQueryStringValue(HKLM, UninstallKey, 'UninstallString', Result) then
    RegQueryStringValue(HKLM32, UninstallKey, 'UninstallString', Result);
end;

procedure RemoveOldAdminInstall();
var
  UninstallString: String;
  ResultCode: Integer;
begin
  UninstallString := GetOldUninstallString();
  if UninstallString <> '' then
  begin
    Log('Found old admin install, running uninstaller: ' + UninstallString);
    // Visible UAC prompt instead of a hidden PowerShell with -ExecutionPolicy Bypass.
    ShellExec('runas', RemoveQuotes(UninstallString), '/VERYSILENT /NORESTART', '', SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode);
    Log('Old uninstaller finished with code: ' + IntToStr(ResultCode));
  end;
end;

procedure UpdatePrepareStatus(const Msg: String);
begin
  if not WizardSilent then
    WizardForm.PreparingLabel.Caption := Msg;
  Log(Msg);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  UpdatePrepareStatus('Closing RaceIQ...');
  // Only RaceIQ itself is closed; other programs on port 3117 are never touched.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM raceiq.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  if GetOldUninstallString() <> '' then
  begin
    UpdatePrepareStatus('Removing old install...');
    RemoveOldAdminInstall();
  end;

  Result := '';
end;

[Files]
Source: "..\dist\raceiq.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\data\*"; DestDir: "{app}\data"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\node_modules\@libsql\win32-x64-msvc\*"; DestDir: "{app}\node_modules\@libsql\win32-x64-msvc"; Flags: ignoreversion
Source: "..\dist\node_modules\@duckdb\node-bindings-win32-x64\*"; DestDir: "{app}\node_modules\@duckdb\node-bindings-win32-x64"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Public contains only packaged assets; replace it completely on every install/upgrade.
; User data lives under data and is intentionally preserved.
Type: filesandordirs; Name: "{app}\public\*"
; Upstream hidden-window VBS launcher and PowerShell credential helper are no longer used.
Type: files; Name: "{app}\raceiq-launcher.vbs"
Type: files; Name: "{app}\credstore.ps1"

[Registry]
; Start with Windows only when the user ticks it; otherwise remove any entry an
; earlier install created.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "RaceIQ"; ValueData: """{app}\raceiq.exe"""; Flags: uninsdeletevalue; Tasks: startup
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "RaceIQ"; Flags: deletevalue; Check: not WizardIsTaskSelected('startup')
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"; ValueName: "RaceIQ"; Flags: deletevalue uninsdeletevalue

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--open-dashboard"; WorkingDir: "{app}"
Name: "{userprograms}\{cm:StopRaceIQ}"; Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM raceiq.exe"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{userprograms}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--open-dashboard"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Exactly one launch: the checkbox page in interactive installs, automatic in silent ones.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--open-dashboard"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent runasoriginaluser
Filename: "{app}\{#MyAppExeName}"; Parameters: "--open-dashboard"; WorkingDir: "{app}"; Flags: nowait skipifnotsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM raceiq.exe"; Flags: runhidden; RunOnceId: "KillRaceIQ"
Filename: "{sys}\cmdkey.exe"; Parameters: "/delete:RaceIQ:gemini-api-key"; Flags: runhidden; RunOnceId: "DeleteApiKey"
