// biome-ignore lint/correctness/noUnusedVariables: CloudFront invokes this entry point.
function handler(event) {
  var response = event.response
  var parameter = event.request.querystring["response-content-disposition"]
  if (!parameter || parameter.multiValue || response.statusCode >= 400) return response
  var disposition
  try {
    disposition = decodeURIComponent(parameter.value.replace(/\+/g, " "))
  } catch (_error) {
    return response
  }
  if (
    disposition.length > 4096 ||
    !/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[\x20-\x7e]*$/.test(disposition)
  )
    return response
  response.headers["content-disposition"] = { value: disposition }
  // Attachment metadata belongs to this request, not the cached object or another user's filename.
  response.headers["cache-control"] = { value: "private, no-store" }
  return response
}
