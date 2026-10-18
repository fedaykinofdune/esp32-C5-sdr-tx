/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The waveform buffer of the playground: the host writes words into the DAC engine's
 * bank (the replay buffer) and loops them through the DAC engine at 80 or 40 MS/s, as
 * pulses with the transmitter off in between, or through the CPU-paced TX DC path at a
 * low rate. The waveforms are made on the host (web/), so anything periodic goes: tones,
 * multitone, chirps, noise, PSK and QAM with pulse shaping, OFDM symbols.
 *
 * Word formats, as the paths take them:
 *   replay: esp_sdr_replay_word(), I in bits 9:0 and Q in bits 19:10, -511 to 511
 *   paced:  I in bits 15:0 and Q in bits 31:16, -32767 to 32767
 */

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/app_version.h>
#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/base64.h>
#include <zephyr/sys/crc.h>
#include <zephyr/sys/util.h>

#include <esp_sdr/esp_sdr.h>
#include <esp_sdr/esp_sdr_paced.h>
#include <esp_sdr/esp_sdr_replay.h>

/* Longest paced run: the shell is blocked (interrupts locked) meanwhile. */
#define WAVE_PACED_MAX_MS 60000U

static long arg(char **argv, size_t argc, size_t i, long def)
{
	return argc > i ? strtol(argv[i], NULL, 0) : def;
}

/* The pulse thread: passes on, then the transmitter off, until "wave stop". */
static struct esp_sdr_replay_cfg pulse_cfg;
static uint32_t pulse_off_ms;
static atomic_t pulse_run;
static uint32_t pulse_count;
static int pulse_err;
static K_THREAD_STACK_DEFINE(pulse_stack, 1024);
static struct k_thread pulse_thread;
static K_SEM_DEFINE(pulse_done, 0, 1);

static void pulse_fn(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	for (;;) {
		k_thread_suspend(k_current_get());
		while (atomic_get(&pulse_run)) {
			/* The pass count bounds the burst: about 0.2 to 52 ms at 80 MS/s. */
			uint32_t burst_us = (uint32_t)((uint64_t)pulse_cfg.count * pulse_cfg.passes *
						       (pulse_cfg.rate == ESP_SDR_RATE_40MSPS ? 25U
											       : 13U) /
						       1000U) + 1000U;

			pulse_err = esp_sdr_replay_start(&pulse_cfg);
			if (pulse_err != 0) {
				atomic_set(&pulse_run, 0);
				break;
			}
			pulse_err = esp_sdr_replay_wait(MAX(burst_us, 2000U), NULL);
			esp_sdr_replay_stop();
			pulse_count++;
			for (uint32_t t = 0; t < pulse_off_ms && atomic_get(&pulse_run); t += 20U) {
				k_sleep(K_MSEC(MIN(20U, pulse_off_ms - t)));
			}
			if (pulse_off_ms == 0U) {
				k_yield();
			}
		}
		esp_sdr_replay_stop();
		k_sem_give(&pulse_done);
	}
}

static void pulse_stop(void)
{
	if (atomic_cas(&pulse_run, 1, 0)) {
		(void)k_sem_take(&pulse_done, K_SECONDS(5));
	}
}

static bool wave_busy(const struct shell *sh)
{
	if (atomic_get(&pulse_run) || esp_sdr_replay_active()) {
		shell_error(sh, "wave: transmitting, wave stop (or probe tx stop) first");
		return true;
	}
	return false;
}

/* wave info: what the image can do, one line the host parses. */
static int cmd_wave_info(const struct shell *sh, size_t argc, char **argv)
{
	uint32_t fmin, fmax;
	size_t words;

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	(void)esp_sdr_replay_buf(&words);
	esp_sdr_tx_paced_range(&fmin, &fmax);
	shell_print(sh, "info app playground version %s board %s words %u cpu %u paced %u-%u "
			"f %u rxgainmax %d",
		    APP_VERSION_STRING, CONFIG_BOARD_TARGET, (unsigned int)words,
		    (unsigned int)ESP_SDR_CPU_HZ, fmin, fmax, esp_sdr_get_freq(),
		    esp_sdr_rx_gain_max());
	return 0;
}

/* wave put <offset> <base64>: little-endian words into the buffer at word offset. */
static int cmd_wave_put(const struct shell *sh, size_t argc, char **argv)
{
	long off = arg(argv, argc, 1, -1);
	size_t words, olen = 0;
	uint32_t *buf;
	int ret;

	if (wave_busy(sh)) {
		return -EBUSY;
	}
	buf = esp_sdr_replay_buf(&words);
	if (off < 0 || off >= (long)words) {
		shell_error(sh, "put: offset 0..%u", (unsigned int)words - 1U);
		return -EINVAL;
	}
	ret = base64_decode((uint8_t *)&buf[off], (words - (size_t)off) * 4U, &olen,
			    (const uint8_t *)argv[2], strlen(argv[2]));
	if (ret != 0 || olen % 4U != 0U) {
		shell_error(sh, "put: bad base64 or not whole words (%d)", ret);
		return -EINVAL;
	}
	shell_print(sh, "put %ld %u", off, (unsigned int)(olen / 4U));
	return 0;
}

/* wave crc <n>: CRC-32 (IEEE) of the first n words, to check an upload. */
static int cmd_wave_crc(const struct shell *sh, size_t argc, char **argv)
{
	size_t words;
	const uint32_t *buf = esp_sdr_replay_buf(&words);
	long n = arg(argv, argc, 1, (long)words);

	if (n < 1 || n > (long)words) {
		shell_error(sh, "crc: n 1..%u", (unsigned int)words);
		return -EINVAL;
	}
	shell_print(sh, "crc %u %08x", (unsigned int)n,
		    crc32_ieee((const uint8_t *)buf, (size_t)n * 4U));
	return 0;
}

static int replay_cfg(const struct shell *sh, size_t argc, char **argv,
		      struct esp_sdr_replay_cfg *cfg)
{
	*cfg = (struct esp_sdr_replay_cfg){
		.count = (size_t)arg(argv, argc, 1, 0),
		.rate = (enum esp_sdr_rate)arg(argv, argc, 2, ESP_SDR_RATE_40MSPS),
		.passes = (unsigned int)arg(argv, argc, 3, 0),
		.scale = (uint8_t)CLAMP(arg(argv, argc, 4, 0), 0, 255),
		.power = 15,
	};
	if (cfg->count < 1U || cfg->count > ESP_SDR_REPLAY_MAX ||
	    (cfg->rate != ESP_SDR_RATE_80MSPS && cfg->rate != ESP_SDR_RATE_40MSPS) ||
	    cfg->passes > 255U) {
		shell_error(sh, "wave: n 1..%u, rate 0 (80 MS/s) or 1 (40 MS/s), passes 0..255",
			    ESP_SDR_REPLAY_MAX);
		return -EINVAL;
	}
	return 0;
}

/*
 * wave play <n> [rate 0|1] [passes] [scale]: loop the first n words through the DAC engine.
 * passes 0 plays until "wave stop"; otherwise the command waits for the passes and stops.
 */
static int cmd_wave_play(const struct shell *sh, size_t argc, char **argv)
{
	struct esp_sdr_replay_cfg cfg;
	uint32_t cycles = 0;
	int ret;

	if (wave_busy(sh)) {
		return -EBUSY;
	}
	ret = replay_cfg(sh, argc, argv, &cfg);
	if (ret != 0) {
		return ret;
	}
	ret = esp_sdr_replay_start(&cfg);
	if (ret != 0) {
		shell_print(sh, "play ret %d", ret);
		return 0;
	}
	if (cfg.passes != 0U) {
		ret = esp_sdr_replay_wait(1000000, &cycles);
		esp_sdr_replay_stop();
		shell_print(sh, "play ret %d n %u passes %u cycles %u f %u", ret,
			    (unsigned int)cfg.count, cfg.passes, cycles, esp_sdr_get_freq());
		return 0;
	}
	shell_print(sh, "play ret 0 n %u passes 0 f %u", (unsigned int)cfg.count,
		    esp_sdr_get_freq());
	return 0;
}

/*
 * wave pulse <n> <rate 0|1> <passes> <off ms> [scale]: bursts of passes, the transmitter
 * off for off ms between them, until "wave stop".
 */
static int cmd_wave_pulse(const struct shell *sh, size_t argc, char **argv)
{
	static bool started;
	struct esp_sdr_replay_cfg cfg;
	char *av[5] = {argv[0], argv[1], argv[2], argv[3], argc > 5 ? argv[5] : "0"};
	int ret;

	if (wave_busy(sh)) {
		return -EBUSY;
	}
	ret = replay_cfg(sh, 5, av, &cfg);
	if (ret != 0) {
		return ret;
	}
	if (cfg.passes == 0U) {
		shell_error(sh, "pulse: passes 1..255");
		return -EINVAL;
	}
	pulse_cfg = cfg;
	pulse_off_ms = (uint32_t)CLAMP(arg(argv, argc, 4, 100), 0, 60000);
	pulse_count = 0;
	pulse_err = 0;
	k_sem_reset(&pulse_done);
	if (!started) {
		k_thread_create(&pulse_thread, pulse_stack, K_THREAD_STACK_SIZEOF(pulse_stack),
				pulse_fn, NULL, NULL, NULL, K_PRIO_PREEMPT(8), 0, K_NO_WAIT);
		k_thread_name_set(&pulse_thread, "pulse");
		started = true;
		k_sleep(K_MSEC(1));
	}
	atomic_set(&pulse_run, 1);
	k_thread_resume(&pulse_thread);
	shell_print(sh, "pulse ret 0 n %u passes %u off %u f %u", (unsigned int)cfg.count,
		    cfg.passes, pulse_off_ms, esp_sdr_get_freq());
	return 0;
}

/* The paced path's input: the buffer as a loop of int16 pairs. */
static struct {
	const uint32_t *tab;
	size_t len, pos;
} pc;

static bool paced_input(void *user, int16_t *i, int16_t *q)
{
	uint32_t w = pc.tab[pc.pos];

	ARG_UNUSED(user);
	pc.pos = pc.pos + 1U == pc.len ? 0U : pc.pos + 1U;
	*i = (int16_t)(w & 0xffffU);
	*q = (int16_t)(w >> 16);
	return true;
}

/*
 * wave paced <n> <rate Hz> [ms] [interp]: loop the first n words (int16 pairs) through
 * the CPU-paced TX DC path for ms (blocks the shell meanwhile), 2400 to 5900 MHz.
 */
static int cmd_wave_paced(const struct shell *sh, size_t argc, char **argv)
{
	long n = arg(argv, argc, 1, 0);
	long rate = arg(argv, argc, 2, 250000);
	uint32_t ms = (uint32_t)CLAMP(arg(argv, argc, 3, 2000), 1, (long)WAVE_PACED_MAX_MS);
	unsigned int interp = (unsigned int)arg(argv, argc, 4, 4);
	struct esp_sdr_paced_stats st;
	uint32_t c0, dt;
	unsigned int key;
	size_t words;
	int ret;

	if (wave_busy(sh)) {
		return -EBUSY;
	}
	pc.tab = esp_sdr_replay_buf(&words);
	if (n < 1 || n > (long)words || rate <= 0) {
		shell_error(sh, "paced: n 1..%u, rate > 0", (unsigned int)words);
		return -EINVAL;
	}
	pc.len = (size_t)n;
	pc.pos = 0;
	ret = esp_sdr_tx_paced_start((uint32_t)rate, interp, 0, paced_input, NULL);
	if (ret != 0) {
		shell_print(sh, "paced ret %d", ret);
		return 0;
	}
	key = irq_lock();
	esp_sdr_paced_sync();
	c0 = esp_sdr_paced_cycles();
	dt = (uint32_t)((uint64_t)ms * (ESP_SDR_CPU_HZ / 1000U));
	while (esp_sdr_paced_cycles() - c0 < dt) {
		(void)esp_sdr_tx_paced_poll();
	}
	irq_unlock(key);
	esp_sdr_paced_get_stats(&st);
	esp_sdr_tx_paced_stop();
	shell_print(sh, "paced ret 0 n %ld rate %ld x%u ms %u samples %llu late %u late_max %u "
			"f %u",
		    n, rate, interp, ms, (unsigned long long)st.samples, st.late, st.late_max,
		    esp_sdr_get_freq());
	return 0;
}

/* wave state: what is on air. */
static int cmd_wave_state(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	shell_print(sh, "state replay %d pulse %d pulses %u err %d f %u",
		    esp_sdr_replay_active() ? 1 : 0, (int)atomic_get(&pulse_run), pulse_count,
		    pulse_err, esp_sdr_get_freq());
	return 0;
}

/* wave stop: the pulses and any replay off. */
static int cmd_wave_stop(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);
	pulse_stop();
	esp_sdr_replay_stop();
	shell_print(sh, "stop ret 0");
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(wave_cmds,
	SHELL_CMD(info, NULL, "what the image can do", cmd_wave_info),
	SHELL_CMD_ARG(put, NULL, "<offset> <base64>: words into the buffer", cmd_wave_put, 3, 0),
	SHELL_CMD_ARG(crc, NULL, "<n>: CRC-32 of the first n words", cmd_wave_crc, 1, 1),
	SHELL_CMD_ARG(play, NULL, "<n> [rate 0|1] [passes] [scale]: DAC engine loop", cmd_wave_play,
		      2, 3),
	SHELL_CMD_ARG(pulse, NULL, "<n> <rate 0|1> <passes> <off ms> [scale]: bursts until stop",
		      cmd_wave_pulse, 5, 1),
	SHELL_CMD_ARG(paced, NULL, "<n> <rate Hz> [ms] [interp]: paced TX DC loop", cmd_wave_paced,
		      3, 2),
	SHELL_CMD(state, NULL, "what is on air", cmd_wave_state),
	SHELL_CMD(stop, NULL, "pulses and replay off", cmd_wave_stop),
	SHELL_SUBCMD_SET_END);
SHELL_CMD_REGISTER(wave, &wave_cmds, "Waveform buffer: upload and play", NULL);
