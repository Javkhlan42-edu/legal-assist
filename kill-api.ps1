# Kill the API process using port 3001
$tcpConn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($tcpConn) {
    $procId = $tcpConn.OwningProcess
    Write-Host "Killing process $procId using port 3001..."
    & taskkill /PID $procId /F
    Write-Host "Process killed. Waiting 2 seconds..."
    Start-Sleep -Seconds 2
    Write-Host "Port 3001 should now be free."
} else {
    Write-Host "Port 3001 is not in use."
}
