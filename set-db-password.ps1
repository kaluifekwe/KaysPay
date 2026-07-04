Write-Host "TYPE YOUR DATABASE PASSWORD BELOW:" -ForegroundColor Yellow
$p = Read-Host "Password"
$envFile = "C:\Projects\KaysPay\.env"
$c = Get-Content $envFile -Raw
$c = $c -replace 'SUPABASE_DB_PASSWORD=.*', "SUPABASE_DB_PASSWORD=$p"
Set-Content $envFile -Value $c -NoNewline
Write-Host "Password saved!" -ForegroundColor Green
Start-Sleep -Seconds 3
