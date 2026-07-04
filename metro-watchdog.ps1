# Kay's Pay - Metro Watchdog
# Checks if Metro is running on port 8081, restarts if dead
# Run via Windows Task Scheduler every 30 seconds

$Port = 8081
$ProjectDir = "C:\Projects\KaysPay"

$connection = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' } | Select-Object -First 1

if (-not $connection) {
    # Kill any zombie processes
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        try { $_.CommandLine -like "*expo*" -or $_.CommandLine -like "*metro*" } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue

    Start-Sleep -Seconds 2
    
    # Start Metro
    Start-Process cmd -ArgumentList "/k", "cd /d $ProjectDir && npx expo start --port $Port" -WindowStyle Normal
}
