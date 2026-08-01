$port = 8000
$rootPath = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-MimeType {
    param([string]$path)
    $ext = [System.IO.Path]::GetExtension($path).ToLower()
    $mimeTypes = @{
        ".html" = "text/html; charset=utf-8"
        ".js"   = "application/javascript; charset=utf-8"
        ".css"  = "text/css; charset=utf-8"
        ".json" = "application/json"
        ".webm" = "video/webm"
        ".mp4"  = "video/mp4"
        ".png"  = "image/png"
        ".jpg"  = "image/jpeg"
        ".gif"  = "image/gif"
        ".svg"  = "image/svg+xml"
    }
    return $mimeTypes[$ext] -or "application/octet-stream"
}

Write-Host "Starting server at http://localhost:$port" -ForegroundColor Green
Write-Host "Directory: $rootPath" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop server" -ForegroundColor Yellow

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $url = $request.Url.LocalPath
        if ($url -eq "/") { $url = "/index.html" }
        
        $filePath = Join-Path $rootPath $url.TrimStart("/")
        
        if (Test-Path $filePath -PathType Leaf) {
            $content = [System.IO.File]::ReadAllBytes($filePath)
            $response.ContentType = (Get-MimeType $filePath)
            $response.OutputStream.Write($content, 0, $content.Length)
            Write-Host "GET $url (200)" -ForegroundColor Green
        } else {
            $response.StatusCode = 404
            $errorMsg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $url")
            $response.OutputStream.Write($errorMsg, 0, $errorMsg.Length)
            Write-Host "GET $url (404)" -ForegroundColor Red
        }
        
        $response.Close()
    }
    catch {
        Write-Host "Error: $_" -ForegroundColor Yellow
    }
}
