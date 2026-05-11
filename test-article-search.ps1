$testQuery = @{
    message = "Eregiin huuriin 1.1 dugaar zuil"
    conversationId = "test-article-1.1"
} | ConvertTo-Json

Write-Host "Testing Article 1.1 Search"
Write-Host "Query: Criminal Law Article 1.1"

Write-Host "Testing health endpoint first..."
try {
    $healthUri = "http://localhost:3001/health"
    $healthRequest = [System.Net.HttpWebRequest]::Create($healthUri)
    $healthRequest.Method = "GET"
    $healthResponse = $healthRequest.GetResponse()
    Write-Host "Health check passed: $($healthResponse.StatusCode)"
    $healthResponse.Close()
} catch {
    Write-Host "Health check failed: $($_.Exception.Message)"
}

Write-Host ""

try {
    $uri = "http://localhost:3001/v1/chat"
    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.Method = "POST"
    $request.ContentType = "application/json"
    
    $stream = $request.GetRequestStream()
    $writer = New-Object System.IO.StreamWriter($stream)
    $writer.Write($testQuery)
    $writer.Flush()
    $writer.Close()
    
    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $content = $reader.ReadToEnd()
    $reader.Close()
    
    Write-Host "Success!"
    Write-Host "Status: $($response.StatusCode)"
    Write-Host "Response: $content"
    
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
