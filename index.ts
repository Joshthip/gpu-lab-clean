import * as gcp from "@pulumi/gcp";

const project = "theta-experiments";
const region  = "us-central1";
const zone    = "us-central1-b";

const networkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/global/networks/joshua-gpu-lab-vpc";
const subnetworkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/regions/us-central1/subnetworks/gpu-uscentral1-subnet";

/** Nightly stop policy — 8 PM PT */
const dailyStop = new gcp.compute.ResourcePolicy("joshua-instance-testing-daily-stop", {
  name: "joshua-instance-testing-daily-stop",
  region,
  description: "Stop instance nightly at 8 PM PT",
  instanceSchedulePolicy: {
    vmStopSchedule: { schedule: "0 20 * * *" },
    timeZone: "America/Los_Angeles",
  },
});

/** Recreate the original GPU VM */
const vm = new gcp.compute.Instance("vm", {
  project,
  name: "joshua-instance-testing",
  zone,

  bootDisk: {
    deviceName: "joshua-instance-testing",
    guestOsFeatures: [
      "VIRTIO_SCSI_MULTIQUEUE",
      "SEV_CAPABLE",
      "SEV_SNP_CAPABLE",
      "SEV_LIVE_MIGRATABLE",
      "SEV_LIVE_MIGRATABLE_V2",
      "SNP_SVSM_CAPABLE",
      "IDPF",
      "TDX_CAPABLE",
      "UEFI_COMPATIBLE",
      "GVNIC",
    ],
    initializeParams: {
      architecture: "X86_64",
      image:
        "https://www.googleapis.com/compute/beta/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20250805",
      size: 50,
      type: "pd-balanced",
    },
  },

  keyRevocationActionType: "NONE",
  machineType: "custom-2-4096", // 2 vCPU / 4 GB

  metadata: {
    "enable-osconfig": "TRUE",
    "enable-oslogin": "true",
  },

  networkInterfaces: [
    {
      accessConfigs: [{ networkTier: "PREMIUM" }], // ephemeral external IP
      network: networkLink,
      stackType: "IPV4_ONLY",
      subnetwork: subnetworkLink,
      subnetworkProject: project,
    },
  ],

  reservationAffinity: { type: "ANY_RESERVATION" },

  // GPUs require TERMINATE
  scheduling: {
    onHostMaintenance: "TERMINATE",
    provisioningModel: "STANDARD",
  },

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

  // Your provider expects a single string here
  resourcePolicies: dailyStop.id,
}, {
  // TEMPORARILY omit protect so Pulumi can recreate it
  // We'll re-enable protection after it's up.
  protect: true,
  // Optional future hardening:
  // ignoreChanges: ["bootDisk[0].deviceName"],
});

// Helper to create minimal Ubuntu VM (2 vCPU / 2GB, no GPU)
function makeCheapVm(name: string) {
  return new gcp.compute.Instance(name, {
    project: "theta-experiments",
    name,
    zone: "us-central1-b",
    machineType: "e2-small",
    bootDisk: {
      initializeParams: {
        image: "https://www.googleapis.com/compute/beta/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20250805",
        size: 10,
        type: "pd-balanced",
      },
    },
    metadata: {
      "enable-oslogin": "true",
      "enable-osconfig": "TRUE",
    },
    networkInterfaces: [{
      network: "https://www.googleapis.com/compute/v1/projects/theta-experiments/global/networks/joshua-gpu-lab-vpc",
      subnetwork: "https://www.googleapis.com/compute/v1/projects/theta-experiments/regions/us-central1/subnetworks/gpu-uscentral1-subnet",
      subnetworkProject: "theta-experiments",
      stackType: "IPV4_ONLY",
      accessConfigs: [{}], // ephemeral external IP for SSH
    }],
    serviceAccount: { scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
    guestAccelerators: [], // no GPU
    scheduling: { provisioningModel: "STANDARD" },
    // Your provider expects a single string (not array)
    resourcePolicies: dailyStop.id,
    allowStoppingForUpdate: true,
  });
}

// Two new VMs on same VPC/subnet
const vmA = makeCheapVm("lab-clean-vm-a");
const vmB = makeCheapVm("lab-clean-vm-b");