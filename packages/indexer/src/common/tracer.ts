import tracer from "dd-trace";
import { getServiceName } from "@/config/network";

if (process.env.DATADOG_AGENT_URL) {
  const service = getServiceName();

  tracer.init({
    profiling: true,
    logInjection: true,
    runtimeMetrics: true,
    clientIpEnabled: true,
    service,
    url: process.env.DATADOG_AGENT_URL,
    ingestion: {
      sampleRate: 0.1,
    },
  });

  tracer.use("hapi", {
    headers: ["x-api-key", "referer"],
  });
}

export default tracer;
