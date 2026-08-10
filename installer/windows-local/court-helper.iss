#define AppName "Court Helper"
#ifndef AppVersion
#define AppVersion "0.0.0"
#endif
#ifndef StagingDir
#define StagingDir "release\\local-staging"
#endif
#ifndef OutputDir
#define OutputDir "release"
#endif

[Setup]
AppId={{B8BDEB46-36B3-4C34-AE91-7D6B3E4A91F2}}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\CourtHelper
DefaultGroupName={#AppName}
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=court-helper-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\runtime\node.exe
WizardStyle=modern

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StagingDir}\installer\windows-local\prepare-upgrade.ps1"; Flags: dontcopy

[Icons]
Name: "{autodesktop}\法院查询助手"; Filename: "{app}\runtime\node.exe"; Parameters: "{app}\installer\windows-local\open-console.mjs"; WorkingDir: "{app}"
Name: "{group}\法院查询助手"; Filename: "{app}\runtime\node.exe"; Parameters: "{app}\installer\windows-local\open-console.mjs"; WorkingDir: "{app}"
Name: "{group}\诊断与修复"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows-local\diagnose.ps1"""; WorkingDir: "{app}"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows-local\bootstrap.ps1"" -InstallRoot ""{app}"" -AdminPasswordFile ""{tmp}\court-helper-admin-password.txt"""; Flags: runhidden waituntilterminated
Filename: "{app}\installer\windows-local\open-onboarding.cmd"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows-local\uninstall.ps1"" -InstallRoot ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "CourtHelperServices"

[Code]
var
  PasswordPage: TInputQueryWizardPage;
  DeleteDataOnUninstall: Boolean;

procedure InitializeWizard;
begin
  PasswordPage := CreateInputQueryPage(wpSelectDir, '设置管理员密码',
    '请输入法院查询助手后台管理员密码', '密码至少 12 位，仅用于首次创建本地管理员账号。');
  PasswordPage.Add('管理员密码：', True);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  I: Integer;
begin
  Result := True;
  if (CurPageID = PasswordPage.ID) and (Length(PasswordPage.Values[0]) < 12) then
  begin
    MsgBox('管理员密码至少需要 12 位。', mbError, MB_OK);
    Result := False;
    exit;
  end;
  if CurPageID = PasswordPage.ID then
  begin
    for I := 1 to Length(PasswordPage.Values[0]) do
      if Pos(PasswordPage.Values[0][I], 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@%_-') = 0 then
      begin
        MsgBox('密码只能包含英文字母、数字和 ! @ % _ -。', mbError, MB_OK);
        Result := False;
        exit;
      end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if not SaveStringToFile(ExpandConstant('{tmp}\court-helper-admin-password.txt'), PasswordPage.Values[0], False) then
  begin
    Result := '无法安全准备管理员密码文件。';
    exit;
  end;
  ExtractTemporaryFile('prepare-upgrade.ps1');
  if not Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\prepare-upgrade.ps1') + '" -InstallRoot "' + ExpandConstant('{app}') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    Result := '升级前备份或服务停止失败，安装已取消。';
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  DeleteDataOnUninstall := False;
  if MsgBox('是否同时永久删除本地业务数据和备份？默认建议选择“否”。', mbConfirmation, MB_YESNO) = IDYES then
    DeleteDataOnUninstall := MsgBox('此操作不可恢复。确认永久删除 %ProgramData%\CourtHelper 中的全部数据吗？', mbConfirmation, MB_YESNO) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DeleteDataOnUninstall then
    DelTree(ExpandConstant('{commonappdata}\CourtHelper'), True, True, True);
end;
