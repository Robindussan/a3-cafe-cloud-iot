param([string]$Docx, [string]$Pdf)
$w = New-Object -ComObject Word.Application
$w.Visible = $false
try {
  $d = $w.Documents.Open($Docx, $false, $true)
  $paginas = $d.ComputeStatistics(2)   # wdStatisticPages
  $d.ExportAsFixedFormat($Pdf, 17)     # wdExportFormatPDF
  $d.Close($false)
  "paginas=$paginas"
} finally { $w.Quit() }
