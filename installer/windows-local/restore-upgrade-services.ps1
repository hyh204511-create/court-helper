$ErrorActionPreference = 'SilentlyContinue'
if (Get-Service -Name CourtHelperPostgres -ErrorAction SilentlyContinue) {
  Set-Service CourtHelperPostgres -StartupType Automatic
  Start-Service CourtHelperPostgres
}
if (Get-Service -Name CourtHelperBackend -ErrorAction SilentlyContinue) {
  Set-Service CourtHelperBackend -StartupType Automatic
  Start-Service CourtHelperBackend
}
