# Temporary HTTPS access to a NAS

This optional Compose project creates a public Cloudflare Quick Tunnel to the running Cloud10 container. Anyone who has the generated URL can read the dashboard. The connector reaches `http://cloud10:4173` over the `cloud10_default` Docker network.

1. Start the main NAS project using the project name `cloud10`.
2. Copy this folder into the NAS’s Docker shared folder. In Container Manager, create a second project named `cloud10-remote` and select the supplied `compose.yaml`.
3. Start the connector and open its container log. Copy the generated `trycloudflare.com` HTTPS URL and open it on another device.

The URL changes when the connector restarts. To take the link offline, stop the `cloud10-remote` project. The main project continues collecting weather in its named volume. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

For the scheduled Worker and D1 deployment, see the [Cloudflare production guide](../../docs/deployment/cloudflare-production.md).
