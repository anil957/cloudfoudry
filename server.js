

const express = require("express");
const app = express();
require('dotenv').config();
var axios = require('axios');
const queryString = require('querystring');

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set correct Cloud Foundry API endpoints for your region
let cfData = {}
// Middleware to log request details
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Sample route
app.get("/", (req, res) => {
    res.send("Hello World!");
});

const cfUsername = process.env.CF_USERNAME;
const cfPassword = process.env.CF_PASSWORD;
const appName = process.env.APP_NAME;

const cfAuthHeader = "Basic " + Buffer.from(`${cfUsername}:${cfPassword}`).toString("base64");

if (!cfUsername || !cfPassword || !appName) {
    console.error("Please set CF_USERNAME, CF_PASSWORD, and APP_NAME in your environment variables.");
    process.exit(1);
}
let baseLoginUrl = 'https://login.cf.us10-001.hana.ondemand.com';
let baseApiUrl = 'https://api.cf.us10-001.hana.ondemand.com';
// login to cloud foundry for a specific site
async function loginToCF(site, username, password) {
   try {
     const loginUrl = `${baseLoginUrl}/oauth/token`;
     const data = queryString.stringify({
       grant_type: 'password',
       username: username,
       password: password,
       client_id: 'cf',
       client_secret: ''
     });
  const response = await axios({
     method: 'post',
     url: loginUrl,
     data: data,
     headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json'
  }})
     const token = response.data;
     return response.data;
   } catch (error) {
     if (error.response) {
       console.error("Error logging into Cloud Foundry:", {
         status: error.response.status,
         data: error.response.data
       });
     } else {
       console.error("Error logging into Cloud Foundry:", error.message);
     }
   }
}
// get the app stats for a specific app
async function getAppStats(site, token, appName) {
   try {
     const appsUrl = `${baseApiUrl}/v2/apps?q=name:${appName}`;
     const appsResponse = await axios({
        method: 'get',
        url: appsUrl,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
     }})
     if (appsResponse.data.resources.length === 0) {
        throw new Error(`App ${appName} not found`);
     }
     const appGuid = appsResponse.data.resources[0].metadata.guid;
     const statsUrl = `${baseApiUrl}/v2/apps/${appGuid}/stats`;
     const statsResponse = await axios({
        method: 'get',
        url: statsUrl,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
     }})
     return statsResponse.data;
   } catch (error) {
     console.error("Error fetching app stats:", error);
   }
}

// Endpoint to fetch and return app stats
app.get("/app-stats", async (req, res) =>{
    try {
        const cfLoginData = await loginToCF('cf', cfUsername, cfPassword);
        if (!cfLoginData || !cfLoginData.access_token) {
            return res.status(500).json({ error: "Failed to log in to Cloud Foundry" });
        }
        const appStats = await getAppStats('cf', cfLoginData.access_token, appName);
        if (!appStats) {
            return res.status(500).json({ error: "Failed to fetch app stats" });
        }
          // Get app GUID and resource for quotas
          const appsUrl = `${baseApiUrl}/v2/apps?q=name:${appName}`;
          const appsResponse = await axios({
            method: 'get',
            url: appsUrl,
            headers: {
              'Authorization': `Bearer ${cfLoginData.access_token}`,
              'Accept': 'application/json'
            }
          });
          if (appsResponse.data.resources.length === 0) {
            return res.status(404).json({ error: `App ${appName} not found` });
          }
          const appResource = appsResponse.data.resources[0];
          const memory_quota = appResource.entity.memory || appResource.entity.memory_quota || null;
          const disk_quota = appResource.entity.disk_quota || null;

          // Format each instance metric
          const formatted = Object.entries(appStats).map(([instanceId, instance]) => {
            const stats = instance.stats || {};
            return {
              name: appName,
              state: instance.state,
              host: stats.host || null,
              instanceGuid: stats.instance_guid || null,
              uptime: stats.uptime || null,
              fdsQuota: stats.fds_quota,
              memQuota: stats.mem_quota,
              diskQuota: stats.disk_quota,
              log_rate_limit: stats.log_rate_limit,
              time: stats.usage.time,
              cpuUsage: stats.usage.cpu || null,
              cpuEntitlement: stats.usage.cpu_entitlement,
              memoryUsage: stats.usage.mem || null,
              diskUsage: stats.usage.disk || null,
              logRates: stats.log_rate_limit || null
            };
          });
          res.json(formatted);
    } catch (error) {
        console.error("Error in /app-stats endpoint:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Endpoint to fetch datacenter-level aggregated metrics
app.get("/datacenter-metrics", async (req, res) => {
  try {
    const cfLoginData = await loginToCF('cf', cfUsername, cfPassword);
    if (!cfLoginData || !cfLoginData.access_token) {
      return res.status(500).json({ error: "Failed to log in to Cloud Foundry" });
    }
    // Get app GUID
    const appsUrl = `${baseApiUrl}/v2/apps?q=name:${appName}`;
    const appsResponse = await axios({
      method: 'get',
      url: appsUrl,
      headers: {
        'Authorization': `Bearer ${cfLoginData.access_token}`,
        'Accept': 'application/json'
      }
    });
    if (appsResponse.data.resources.length === 0) {
      return res.status(404).json({ error: `App ${appName} not found` });
    }
    const appResource = appsResponse.data.resources[0];
    const appGuid = appResource.metadata.guid;
    // Get quotas from app resource
    const memory_quota = appResource.entity.memory || appResource.entity.memory_quota || null;
    const disk_quota = appResource.entity.disk_quota || null;
    // Get instance metrics
    const statsUrl = `${baseApiUrl}/v2/apps/${appGuid}/stats`;
    const statsResponse = await axios({
      method: 'get',
      url: statsUrl,
      headers: {
        'Authorization': `Bearer ${cfLoginData.access_token}`,
        'Accept': 'application/json'
      }
    });
    // Aggregate metrics
    let totalCPU = 0, totalMemory = 0, totalDisk = 0, count = 0;
    Object.values(statsResponse.data).forEach(instance => {
      const usage = instance.stats?.usage || {};
      if (usage.cpu != null) totalCPU += usage.cpu;
      if (usage.memory != null) totalMemory += usage.memory;
      if (usage.disk != null) totalDisk += usage.disk;
      count++;
    });
    res.json({
      datacenter: appName,
      app_name: appName,
      instance_count: count,
      total_cpu: totalCPU,
      total_memory: totalMemory,
      total_disk: totalDisk,
      memory_quota,
      disk_quota
    });
  } catch (error) {
    console.error("Error in /datacenter-metrics endpoint:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


axios.interceptors.request.use((req) => {
  console.log(req.baseURL);
  return req;
});
