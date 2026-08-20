# KaysPay - Persistent Metro Server
# Auto-restarts if crashed, runs on port 8081
# Usage: powershell -ExecutionPolicy Bypass -File "C:\Projects\KaysPay\metro-server.ps1"

$Port = 8081
$ProjectDir = "C:\Projects\KaysPay"
$LogFile = "C:\Projects\KaysPay\metro-server.log"

Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Starting KaysPay Metro Server on port $Port"

# Kill any existing process on port
$existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

while ($true) {
    try {
        Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Starting Metro Bundler..."
        Set-Location $ProjectDir
        $process = Start-Process -FilePath "npx" -ArgumentList "expo start --port $Port" -WorkingDirectory $ProjectDir -PassThru -NoNewWindow -RedirectStandardOutput "$LogFile" -RedirectStandardError "$LogFile"
        
        Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Metro started (PID: $($process.Id))"
        
        # Wait for process to exit (crash or kill)
        $process.WaitForExit()
        
        Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Metro stopped (exit code: $($process.ExitCode)). Restarting in 5 seconds..."
        Start-Sleep -Seconds 5
    }
    catch {
        Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Error: $($_.Exception.Message). Restarting in 10 seconds..."
        Start-Sleep -Seconds 10
    }
}
