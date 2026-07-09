#include <stdio.h>

int main(void) {
    const char *json = "{\n"
        "  \"scores\": {\n"
        "    \"mlx\": 1,\n"
        "    \"openrouter\": 1,\n"
        "    \"aider\": 6\n"
        "  },\n"
        "  \"winner\": \"aider\",\n"
        "  \"reason\": \"Only aider provided a substantive response addressing the task, while mlx and openrouter gave no action.\"\n"
        "}";
    printf("%s\n", json);
    return 0;
}
