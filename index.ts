import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const project = "theta-experiments";
const region  = "us-central1";
const zone    = "us-central1-b";

const networkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/global/networks/joshua-gpu-lab-vpc";
const subnetworkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/regions/us-central1/subnetworks/gpu-uscentral1-subnet";

/** Nightly stop policy — 8 PM PT (unchanged) */
const dailyStop = new gcp.compute.ResourcePolicy("joshua-instance-testing-daily-stop", {
  name: "joshua-instance-testing-daily-stop",
  region,
  description: "Stop instance nightly at 8 PM PT",
  instanceSchedulePolicy: { vmStopSchedule: { schedule: "0 20 * * *" }, timeZone: "America/Los_Angeles" },
});

/** GPU VM (UNCHANGED & protected) */
const vm = new gcp.compute.Instance("vm", {
  project,
  name: "joshua-instance-testing",
  zone,
  bootDisk: {
    deviceName: "joshua-instance-testing",
    guestOsFeatures: [
      "VIRTIO_SCSI_MULTIQUEUE","SEV_CAPABLE","SEV_SNP_CAPABLE","SEV_LIVE_MIGRATABLE",
      "SEV_LIVE_MIGRATABLE_V2","SNP_SVSM_CAPABLE","IDPF","TDX_CAPABLE","UEFI_COMPATIBLE","GVNIC",
    ],
    initializeParams: {
      architecture: "X86_64",
      image: "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20250805",
      size: 50,
      type: "pd-balanced",
    },
  },
  keyRevocationActionType: "NONE",
  machineType: "custom-2-4096",
  metadata: { "enable-osconfig": "TRUE", "enable-oslogin": "true" },
  networkInterfaces: [{
    accessConfigs: [{ networkTier: "PREMIUM" }], // keep ephemeral on this VM
    network: networkLink,
    stackType: "IPV4_ONLY",
    subnetwork: subnetworkLink,
    subnetworkProject: project,
  }],
  reservationAffinity: { type: "ANY_RESERVATION" },
  scheduling: { onHostMaintenance: "TERMINATE", provisioningModel: "STANDARD" },
  serviceAccount: {
    email: "988885486422-compute@developer.gserviceaccount.com",
    scopes: [
      "https://www.googleapis.com/auth/devstorage.read_only",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
      "https://www.googleapis.com/auth/service.management.readonly",
      "https://www.googleapis.com/auth/servicecontrol",
      "https://www.googleapis.com/auth/trace.append",
    ],
  },
  guestAccelerators: [{ type: "nvidia-tesla-t4", count: 1 }],
  allowStoppingForUpdate: true,
  resourcePolicies: dailyStop.id,
}, { protect: true });

/** Reuse the reserved static public IPs */
const eipA = new gcp.compute.Address("lab-clean-vm-a-eip", { region });
const eipB = new gcp.compute.Address("lab-clean-vm-b-eip", { region });
const eipC = new gcp.compute.Address("lab-clean-vm-c-eip", { region });

/** Minimal N1 + T4 VM with nightly stop + reserved static IP */
function makeT4Vm(name: string, natIp: pulumi.Input<string>) {
  return new gcp.compute.Instance(name, {
    // lock the GCE name (no Pulumi suffix)
    name,

    project,
    zone,
    machineType: "custom-2-4096", // N1 custom: 2 vCPU, 4 GB (low cost)
    bootDisk: {
      deviceName: name,
      initializeParams: {
        // known-good Ubuntu 24.04 image selfLink
        image: "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20250805",
        size: 20,
        type: "pd-balanced",
      },
    },
    metadata: {
      "enable-oslogin": "true",
      "enable-osconfig": "TRUE",
      // "install-nvidia-driver": "true", // uncomment if you want auto driver install
    },
    tags: ["wg-udp-51820"],
    networkInterfaces: [{
      network: networkLink,
      subnetwork: subnetworkLink,
      subnetworkProject: project,
      stackType: "IPV4_ONLY",
      accessConfigs: [{ natIp, networkTier: "PREMIUM" }], // reuse reserved static IP
    }],
    guestAccelerators: [{ type: "nvidia-tesla-t4", count: 1 }],
    scheduling: {
      onHostMaintenance: "TERMINATE", // required for GPU VMs
      provisioningModel: "STANDARD",
    },
    resourcePolicies: dailyStop.id,   // nightly stop @ 8 PM PT
    allowStoppingForUpdate: true,
    serviceAccount: { scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
  }, {
    deleteBeforeReplace: true, // frees the static IP before re-creating
  });
}

// Rebuild with exact names (no suffixes)
const vmA = makeT4Vm("lab-clean-vm-a", eipA.address);
const vmB = makeT4Vm("lab-clean-vm-b", eipB.address);
const vmC = makeT4Vm("lab-clean-vm-c", eipC.address);

/** Outputs */
export const publicIps = {
  "lab-clean-vm-a": eipA.address,
  "lab-clean-vm-b": eipB.address,
  "lab-clean-vm-c": eipC.address,
};
