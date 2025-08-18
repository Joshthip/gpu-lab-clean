import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const project = "theta-experiments";
const region  = "us-central1";
const zone    = "us-central1-b";

const networkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/global/networks/joshua-gpu-lab-vpc";
const subnetworkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/regions/us-central1/subnetworks/gpu-uscentral1-subnet";

/** Nightly stop policy — unchanged */
const dailyStop = new gcp.compute.ResourcePolicy("joshua-instance-testing-daily-stop", {
  name: "joshua-instance-testing-daily-stop",
  region,
  description: "Stop instance nightly at 8 PM PT",
  instanceSchedulePolicy: { vmStopSchedule: { schedule: "0 20 * * *" }, timeZone: "America/Los_Angeles" },
});

/** GPU VM — unchanged */
const vm = new gcp.compute.Instance("vm", {
  project, name: "joshua-instance-testing", zone,
  bootDisk: {
    deviceName: "joshua-instance-testing",
    guestOsFeatures: [
      "VIRTIO_SCSI_MULTIQUEUE","SEV_CAPABLE","SEV_SNP_CAPABLE","SEV_LIVE_MIGRATABLE",
      "SEV_LIVE_MIGRATABLE_V2","SNP_SVSM_CAPABLE","IDPF","TDX_CAPABLE","UEFI_COMPATIBLE","GVNIC",
    ],
    initializeParams: {
      architecture: "X86_64",
      image: "https://www.googleapis.com/compute/beta/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20250805",
      size: 50, type: "pd-balanced",
    },
  },
  keyRevocationActionType: "NONE",
  machineType: "custom-2-4096",
  metadata: { "enable-osconfig": "TRUE", "enable-oslogin": "true" },
  networkInterfaces: [{
    accessConfigs: [{ networkTier: "PREMIUM" }], // leave as ephemeral
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

/** Reserve static public IPs for the three existing small VMs */
const eipA = new gcp.compute.Address("lab-clean-vm-a-eip", { region });
const eipB = new gcp.compute.Address("lab-clean-vm-b-eip", { region });
const eipC = new gcp.compute.Address("lab-clean-vm-c-eip", { region });

/** We’ll adopt the existing instances and only manage natIp on nic0. */
const ignore = [
  "bootDisk","machineType","metadata","tags","serviceAccount","scheduling",
  "guestAccelerators","reservationAffinity","shieldedInstanceConfig","resourcePolicies",
  "canIpForward","minCpuPlatform","deletionProtection","description","labels",
  "networkInterfaces[0].network","networkInterfaces[0].subnetwork","networkInterfaces[0].subnetworkProject",
  "networkInterfaces[0].stackType","networkInterfaces[0].networkIp","networkInterfaces[0].aliasIpRanges",
  "networkInterfaces[0].ipv6AccessConfigs",
];

/** vm-a (adopt + set reserved natIp) */
const vmA = new gcp.compute.Instance("lab-clean-vm-a", {
  zone,
  // minimal placeholders to satisfy typing; ignored via ignoreChanges:
  machineType: "e2-small",
  bootDisk: { initializeParams: { image: "ubuntu-os-cloud/ubuntu-2404-lts" } },
  // the one field we actually want to control:
  networkInterfaces: [{ accessConfigs: [{ natIp: eipA.address }] }],
  allowStoppingForUpdate: true,
}, {
  import: `projects/${project}/zones/${zone}/instances/lab-clean-vm-a`,
  ignoreChanges: ignore,
});

/** vm-b */
const vmB = new gcp.compute.Instance("lab-clean-vm-b", {
  zone,
  machineType: "e2-small",
  bootDisk: { initializeParams: { image: "ubuntu-os-cloud/ubuntu-2404-lts" } },
  networkInterfaces: [{ accessConfigs: [{ natIp: eipB.address }] }],
  allowStoppingForUpdate: true,
}, {
  import: `projects/${project}/zones/${zone}/instances/lab-clean-vm-b`,
  ignoreChanges: ignore,
});

/** vm-c */
const vmC = new gcp.compute.Instance("lab-clean-vm-c", {
  zone,
  machineType: "e2-small",
  bootDisk: { initializeParams: { image: "ubuntu-os-cloud/ubuntu-2404-lts" } },
  networkInterfaces: [{ accessConfigs: [{ natIp: eipC.address }] }],
  allowStoppingForUpdate: true,
}, {
  import: `projects/${project}/zones/${zone}/instances/lab-clean-vm-c`,
  ignoreChanges: ignore,
});

/** Outputs */
export const publicIps = {
  "lab-clean-vm-a": eipA.address,
  "lab-clean-vm-b": eipB.address,
  "lab-clean-vm-c": eipC.address,
};
